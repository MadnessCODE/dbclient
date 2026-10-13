//! Excel (.xlsx) export with typed cells: numbers, booleans and dates stay native in Excel.

use rust_xlsxwriter::{ExcelDateTime, Format, FormatAlign, Workbook, XlsxError};
use serde::Deserialize;

use crate::db::Cell;
use crate::error::{msg, AppResult};

/// Excel row limit per sheet, header included.
const MAX_ROWS: usize = 1_048_576;
/// Excel's max text length per cell.
const MAX_TEXT: usize = 32_767;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxColumn {
    pub name: String,
    /// "number", "bool", "date", "datetime", "time", anything else = text
    pub kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxOptions {
    pub sheet: String,
    pub header: bool,
    pub null_as: String,
}

pub fn write(path: &str, columns: &[XlsxColumn], rows: &[Vec<Cell>], o: &XlsxOptions) -> AppResult<()> {
    build(path, columns, rows, o).map_err(|e| msg(format!("Excel export failed: {e}")))
}

fn build(path: &str, columns: &[XlsxColumn], rows: &[Vec<Cell>], o: &XlsxOptions) -> Result<(), XlsxError> {
    let header_rows = usize::from(o.header);
    if rows.len() + header_rows > MAX_ROWS {
        return Err(XlsxError::RowColumnLimitError);
    }

    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name(sheet_name(&o.sheet))?;

    let bold = Format::new().set_bold().set_background_color("#E8EEF7").set_border_bottom(rust_xlsxwriter::FormatBorder::Thin);
    let date = Format::new().set_num_format("yyyy-mm-dd").set_align(FormatAlign::Left);
    let datetime = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss").set_align(FormatAlign::Left);
    let time = Format::new().set_num_format("hh:mm:ss").set_align(FormatAlign::Left);
    let null = Format::new().set_font_color("#9AA3B2").set_italic();

    if o.header {
        for (c, col) in columns.iter().enumerate() {
            ws.write_string_with_format(0, c as u16, &col.name, &bold)?;
        }
        ws.set_freeze_panes(1, 0)?;
    }

    for (r, row) in rows.iter().enumerate() {
        let er = (r + header_rows) as u32;
        for (c, col) in columns.iter().enumerate() {
            let ec = c as u16;
            let Some(v) = row.get(c).and_then(|v| v.as_deref()) else {
                if !o.null_as.is_empty() {
                    ws.write_string_with_format(er, ec, &o.null_as, &null)?;
                }
                continue;
            };
            match col.kind.as_str() {
                "number" => match number(v) {
                    Some(n) => ws.write_number(er, ec, n)?,
                    None => ws.write_string(er, ec, v)?,
                },
                "bool" => match v.to_ascii_lowercase().as_str() {
                    "1" | "t" | "true" => ws.write_boolean(er, ec, true)?,
                    "0" | "f" | "false" => ws.write_boolean(er, ec, false)?,
                    _ => ws.write_string(er, ec, v)?,
                },
                k @ ("date" | "datetime" | "time") => {
                    let fmt = match k {
                        "date" => &date,
                        "time" => &time,
                        _ => &datetime,
                    };
                    match excel_date(v) {
                        Some(d) => ws.write_datetime_with_format(er, ec, &d, fmt)?,
                        None => ws.write_string(er, ec, v)?,
                    }
                }
                _ => ws.write_string(er, ec, truncate(v))?,
            };
        }
    }

    // Column width from the longest value in the first rows
    for (c, col) in columns.iter().enumerate() {
        let mut len = col.name.chars().count();
        for row in rows.iter().take(1000) {
            if let Some(Some(v)) = row.get(c) {
                len = len.max(v.chars().count().min(60));
            }
        }
        ws.set_column_width(c as u16, (len as f64 + 2.0).clamp(8.0, 62.0))?;
    }
    if o.header && !columns.is_empty() {
        ws.autofilter(0, 0, rows.len() as u32, (columns.len() - 1) as u16)?;
    }

    wb.save(path)
}

/// A number only if Excel can hold it exactly (up to 15 digits); otherwise text.
fn number(v: &str) -> Option<f64> {
    let digits = v.trim_start_matches(['-', '+']).chars().filter(char::is_ascii_digit).skip_while(|&d| d == '0').count();
    if digits > 15 {
        return None;
    }
    v.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

/// "2024-02-29", "2024-02-29 13:45:30.123", "13:45:30"; the zone is dropped (Excel has none).
fn excel_date(v: &str) -> Option<ExcelDateTime> {
    let s = v.trim();
    let s = match s.rfind(['+', 'Z']) {
        Some(i) if i >= 8 => &s[..i],
        _ => match s.rfind('-') {
            // "13:45:30-05" or "2024-01-01 10:00:00-05"
            Some(i) if i > 10 || (i >= 8 && s[..i].contains(':')) => &s[..i],
            _ => s,
        },
    };
    ExcelDateTime::parse_from_str(&s.replacen(' ', "T", 1)).ok()
}

fn truncate(v: &str) -> &str {
    if v.len() <= MAX_TEXT {
        return v;
    }
    let mut end = MAX_TEXT;
    while !v.is_char_boundary(end) {
        end -= 1;
    }
    &v[..end]
}

/// Max 31 chars, no []:*?/\
fn sheet_name(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !"[]:*?/\\".contains(*c)).take(31).collect();
    if clean.trim().is_empty() {
        "Export".into()
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_keep_precision() {
        assert_eq!(number("1234.5678"), Some(1234.5678));
        assert_eq!(number("-0.0001"), Some(-0.0001));
        assert_eq!(number("18446744073709551615"), None);
        assert_eq!(number("abc"), None);
    }

    #[test]
    fn dates_parse() {
        for v in ["2024-02-29", "2024-02-29 13:45:30", "2025-09-01 08:24:12+00", "2025-09-01 08:24:12.123456+02:00", "13:45:30", "13:45:30+02"] {
            assert!(excel_date(v).is_some(), "{v}");
        }
        assert!(excel_date("infinity").is_none());
    }

    #[test]
    fn writes_file() {
        let dir = std::env::temp_dir().join("dbclient_xlsx_test.xlsx");
        let cols = vec![
            XlsxColumn { name: "id".into(), kind: "number".into() },
            XlsxColumn { name: "ok".into(), kind: "bool".into() },
            XlsxColumn { name: "at".into(), kind: "datetime".into() },
            XlsxColumn { name: "txt".into(), kind: "text".into() },
        ];
        let rows = vec![
            vec![Some("1".into()), Some("t".into()), Some("2024-02-29 13:45:30".into()), Some("ćao".into())],
            vec![None, None, Some("infinity".into()), None],
        ];
        let o = XlsxOptions { sheet: "type_showcase".into(), header: true, null_as: "NULL".into() };
        write(dir.to_str().unwrap(), &cols, &rows, &o).unwrap();
        assert!(std::fs::metadata(&dir).unwrap().len() > 1000);
    }
}
