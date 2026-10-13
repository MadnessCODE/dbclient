use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{}", describe_sqlx(.0))]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("Password store error: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("{0}")]
    Msg(String),
}

pub type AppResult<T> = Result<T, AppError>;

pub fn msg(text: impl Into<String>) -> AppError {
    AppError::Msg(text.into())
}

/// Database messages without the sqlx prefix, plus the SQLSTATE code when present.
fn describe_sqlx(err: &sqlx::Error) -> String {
    match err {
        sqlx::Error::Database(db) => match db.code() {
            Some(code) => format!("{} (code {code})", db.message()),
            None => db.message().to_string(),
        },
        sqlx::Error::PoolTimedOut => "Timed out waiting for a database connection".into(),
        other => other.to_string(),
    }
}

// Errors reach the frontend as plain text.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
