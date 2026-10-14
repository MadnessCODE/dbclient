//! Adaptive parallelism for imports ("Auto" mode).
//!
//! All connections are opened up front, but a [`Gate`] lets only `limit` of them take jobs.
//! [`Tuner`] hill-climbs that limit on measured throughput: it keeps adding workers while
//! throughput improves, steps back when it doesn't, and re-probes periodically or when the
//! rate shifts (the optimum differs between one big table, many small ones, index builds...).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tokio::sync::{Semaphore, SemaphorePermit};

pub(crate) const START: usize = 4;
/// Relative change treated as real, not noise.
const NOISE: f64 = 0.07;
/// Workers must be this busy for the limit to be the bottleneck.
const SATURATED: f64 = 0.8;
/// Steady windows between probes.
const PROBE_EVERY: u32 = 10;
/// Rate change while steady that triggers a probe right away.
const SHIFT: f64 = 0.3;

/// Caps how many workers run jobs at once; the cap can change while they run.
pub(crate) struct Gate {
    sem: Semaphore,
    limit: AtomicUsize,
    /// Permits to drop as busy workers release them (the cap went below the number in use).
    debt: Mutex<usize>,
}

impl Gate {
    pub(crate) fn new(limit: usize) -> Self {
        Gate { sem: Semaphore::new(limit), limit: AtomicUsize::new(limit), debt: Mutex::new(0) }
    }

    pub(crate) async fn acquire(&self) -> SemaphorePermit<'_> {
        self.sem.acquire().await.expect("gate semaphore is never closed")
    }

    pub(crate) fn release(&self, permit: SemaphorePermit<'_>) {
        let mut debt = self.debt.lock().unwrap();
        if *debt > 0 {
            *debt -= 1;
            permit.forget();
        }
    }

    pub(crate) fn set(&self, limit: usize) {
        let old = self.limit.swap(limit, Ordering::Relaxed);
        let mut debt = self.debt.lock().unwrap();
        if limit > old {
            let add = limit - old;
            let paid = add.min(*debt);
            *debt -= paid;
            self.sem.add_permits(add - paid);
        } else if limit < old {
            let remove = old - limit;
            *debt += remove - self.sem.forget_permits(remove);
        }
    }
}

/// One measurement window.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Sample {
    /// Data (INSERT/COPY) bytes per second
    pub rate: f64,
    /// Average number of workers running a job
    pub busy: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    /// Trying a higher limit; `from` and `before` are the previous limit and its rate.
    Up { from: usize, before: f64 },
    Down { from: usize, before: f64 },
    Steady { windows: u32, rate: f64 },
}

#[derive(Debug)]
pub(crate) struct Tuner {
    limit: usize,
    max: usize,
    phase: Phase,
    probe_up: bool,
}

impl Tuner {
    pub(crate) fn new(max: usize) -> Self {
        let max = max.max(1);
        // first saturated window probes upwards
        Tuner { limit: START.min(max), max, phase: Phase::Steady { windows: PROBE_EVERY, rate: 0.0 }, probe_up: true }
    }

    pub(crate) fn limit(&self) -> usize {
        self.limit
    }

    /// Feeds one window measured at the current limit; returns the limit for the next one.
    pub(crate) fn step(&mut self, s: Sample) -> usize {
        let saturated = s.busy >= self.limit as f64 * SATURATED;
        match self.phase {
            Phase::Up { from, before } => {
                if saturated && s.rate > before * (1.0 + NOISE) {
                    self.climb(true, s.rate, false);
                } else {
                    // no real gain: fewer connections are cheaper
                    self.settle(from, before);
                }
            }
            Phase::Down { from, before } => {
                if s.rate >= before * (1.0 - NOISE) {
                    self.climb(false, s.rate, false);
                } else {
                    self.settle(from, before);
                }
            }
            Phase::Steady { windows, rate } => {
                if !saturated {
                    // the limit isn't the bottleneck (reader, DDL, few tables)
                    self.phase = Phase::Steady { windows: 0, rate: s.rate };
                    return self.limit;
                }
                let shifted = rate > 0.0 && (s.rate - rate).abs() > rate * SHIFT;
                if windows + 1 >= PROBE_EVERY || shifted {
                    let up = (self.probe_up || self.limit == 1) && self.limit < self.max;
                    self.probe_up = !self.probe_up;
                    self.climb(up, s.rate, true);
                } else {
                    let avg = if rate > 0.0 { rate * 0.7 + s.rate * 0.3 } else { s.rate };
                    self.phase = Phase::Steady { windows: windows + 1, rate: avg };
                }
            }
        }
        self.limit
    }

    /// Moves one step `up` or down from the current limit, measured at `rate`.
    /// Probes and descents move by one; a continued climb upwards accelerates.
    fn climb(&mut self, up: bool, rate: f64, probe: bool) {
        let step = if probe || !up { 1 } else { (self.limit / 4).max(1) };
        let from = self.limit;
        let next = if up { (from + step).min(self.max) } else { from.saturating_sub(step).max(1) };
        if next == from {
            self.phase = Phase::Steady { windows: 0, rate };
            return;
        }
        self.limit = next;
        self.phase = if up { Phase::Up { from, before: rate } } else { Phase::Down { from, before: rate } };
    }

    fn settle(&mut self, limit: usize, rate: f64) {
        self.limit = limit;
        self.phase = Phase::Steady { windows: 0, rate };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the tuner against a throughput curve, workers always saturated.
    fn run(t: &mut Tuner, windows: usize, curve: impl Fn(usize) -> f64) -> Vec<usize> {
        (0..windows)
            .map(|_| {
                let l = t.limit();
                t.step(Sample { rate: curve(l), busy: l as f64 })
            })
            .collect()
    }

    /// Linear up to `peak` workers, then contention makes each extra one costly.
    fn peaked(peak: usize) -> impl Fn(usize) -> f64 {
        move |n| if n <= peak { n as f64 * 100.0 } else { (peak as f64 * 100.0 - (n - peak) as f64 * 40.0).max(10.0) }
    }

    #[test]
    fn climbs_to_the_peak_and_stays_near_it() {
        let mut t = Tuner::new(16);
        let trace = run(&mut t, 200, peaked(7));
        assert!(trace[..15].contains(&7), "{trace:?}");
        // after converging, probes only briefly leave 7
        let tail = &trace[50..];
        assert!(tail.iter().all(|&l| (6..=8).contains(&l)), "{tail:?}");
        assert!(tail.iter().filter(|&&l| l == 7).count() > tail.len() * 3 / 4, "{tail:?}");
    }

    #[test]
    fn goes_down_when_more_workers_only_hurt() {
        let mut t = Tuner::new(16);
        let trace = run(&mut t, 60, peaked(2));
        assert_eq!(*trace.last().unwrap(), 2, "{trace:?}");
    }

    #[test]
    fn reaches_the_cap_when_scaling_is_linear() {
        let mut t = Tuner::new(16);
        let trace = run(&mut t, 60, |n| n as f64 * 100.0);
        // +1 worker at 15 is under the noise threshold, so it hovers just below the cap
        assert!(trace[..20].contains(&16), "{trace:?}");
        assert!(trace[40..].iter().all(|&l| l >= 13), "{trace:?}");
    }

    #[test]
    fn prefers_fewer_workers_on_a_plateau() {
        let mut t = Tuner::new(16);
        let trace = run(&mut t, 80, |n| (n.min(5)) as f64 * 100.0);
        let tail = &trace[40..];
        assert!(tail.iter().all(|&l| (4..=6).contains(&l)), "{tail:?}");
        assert!(tail.iter().filter(|&&l| l == 5).count() > tail.len() * 3 / 4, "{tail:?}");
    }

    #[test]
    fn follows_a_phase_change() {
        let mut t = Tuner::new(16);
        run(&mut t, 60, peaked(10));
        assert!((9..=11).contains(&t.limit()), "{t:?}");
        // one big table now: contention above 3
        let trace = run(&mut t, 80, peaked(3));
        assert!(trace[60..].iter().all(|&l| (2..=4).contains(&l)), "{trace:?}");
        assert_eq!(*trace.last().unwrap(), 3, "{trace:?}");
    }

    #[test]
    fn holds_when_workers_are_starved() {
        let mut t = Tuner::new(16);
        for _ in 0..30 {
            let l = t.limit();
            t.step(Sample { rate: 300.0, busy: 1.5 });
            assert!(t.limit() <= l);
        }
        assert_eq!(t.limit(), START);
    }

    #[test]
    fn respects_small_caps() {
        let mut t = Tuner::new(2);
        assert_eq!(t.limit(), 2);
        let trace = run(&mut t, 30, |n| n as f64 * 100.0);
        assert!(trace.iter().all(|&l| (1..=2).contains(&l)));
        let mut t = Tuner::new(1);
        assert!(run(&mut t, 30, |n| n as f64).iter().all(|&l| l == 1));
    }

    #[tokio::test]
    async fn gate_shrinks_under_busy_workers() {
        let g = Gate::new(3);
        let a = g.acquire().await;
        let b = g.acquire().await;
        g.set(1);
        // one free permit was forgotten; one busy permit is owed
        assert_eq!(g.sem.available_permits(), 0);
        g.release(a);
        assert_eq!(g.sem.available_permits(), 0);
        g.release(b);
        assert_eq!(g.sem.available_permits(), 1);
        g.set(4);
        assert_eq!(g.sem.available_permits(), 4);
        g.set(2);
        assert_eq!(g.sem.available_permits(), 2);
    }
}
