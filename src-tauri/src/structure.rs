//! Table structure: columns, indexes, foreign keys (both directions) and DDL.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::db::{Cell, DbPool};
use crate::error::AppResult;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructColumn {
    pub name: String,
    /// Full type, e.g. "varchar(100)", "bigint unsigned"
    pub column_type: String,
    pub nullable: bool,
    /// Default as an SQL expression (strings already quoted)
    pub default: Option<String>,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub comment: Option<String>,
    pub collation: Option<String>,
    /// Anything else the server reports, e.g. MySQL "on update CURRENT_TIMESTAMP"
    pub extra: Option<String>,
    /// Allowed values of ENUM / MySQL SET
    pub enum_values: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructIndex {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub method: String,
    /// Postgres: backs a PRIMARY KEY / UNIQUE constraint, dropped with DROP CONSTRAINT
    pub constraint: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructForeignKey {
    pub name: String,
    /// Table that holds the key (another table for incoming keys)
    pub table_schema: String,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub schema: String,
    pub table: String,
    pub is_view: bool,
    pub columns: Vec<StructColumn>,
    pub indexes: Vec<StructIndex>,
    pub foreign_keys: Vec<StructForeignKey>,
    pub referenced_by: Vec<StructForeignKey>,
    pub ddl: String,
    pub engine: Option<String>,
    pub row_estimate: Option<String>,
    pub size_bytes: Option<String>,
    pub table_comment: Option<String>,
    pub collation: Option<String>,
}

pub async fn load(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableStructure> {
    match pool {
        DbPool::Pg(_) => load_pg(pool, schema, table).await,
        DbPool::My(_) => load_my(pool, schema, table).await,
    }
}


/// Postgres literal (standard_conforming_strings is on since 9.1).
fn pg_lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn pg_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn pg_rule(code: Option<&str>) -> String {
    match code {
        Some("r") => "RESTRICT",
        Some("c") => "CASCADE",
        Some("n") => "SET NULL",
        Some("d") => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .into()
}

async fn load_pg(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableStructure> {
    let (s, t) = (pg_lit(schema), pg_lit(table));
    let rel = format!("(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = {s} and c.relname = {t})");

    let columns_sql = format!(
        "select a.attname, format_type(a.atttypid, a.atttypmod), not a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
                exists(select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary and a.attnum = any(i.indkey)),
                a.attidentity <> '' or coalesce(pg_get_expr(d.adbin, d.adrelid), '') like 'nextval(%',
                col_description(a.attrelid, a.attnum), coll.collname, a.attidentity, a.attgenerated,
                (select string_agg(e.enumlabel, chr(1) order by e.enumsortorder) from pg_enum e where e.enumtypid = a.atttypid)
           from pg_attribute a
           left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           left join pg_collation coll on coll.oid = a.attcollation and coll.collname <> 'default'
          where a.attrelid = {rel} and a.attnum > 0 and not a.attisdropped
          order by a.attnum"
    );
    let index_sql = format!(
        "select ic.relname, i.indisunique, i.indisprimary, am.amname, coalesce(a.attname, '(expression)'),
                exists(select 1 from pg_constraint c where c.conindid = i.indexrelid)
           from pg_index i
           join pg_class ic on ic.oid = i.indexrelid
           join pg_am am on am.oid = ic.relam
           cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
           left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where i.indrelid = {rel}
          order by i.indisprimary desc, ic.relname, k.ord"
    );
    let fk_sql = |filter: &str| {
        format!(
            "select con.conname, n.nspname, c.relname, a.attname, fn.nspname, fc.relname, fa.attname, con.confupdtype, con.confdeltype
               from pg_constraint con
               join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
               join pg_class fc on fc.oid = con.confrelid join pg_namespace fn on fn.oid = fc.relnamespace
               cross join lateral unnest(con.conkey, con.confkey) with ordinality k(att, fatt, ord)
               join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.att
               join pg_attribute fa on fa.attrelid = con.confrelid and fa.attnum = k.fatt
              where con.contype = 'f' and {filter}
              order by con.conname, k.ord"
        )
    };
    let info_sql = format!(
        "select c.relkind, c.reltuples::bigint, pg_total_relation_size(c.oid), obj_description(c.oid, 'pg_class'),
                case when c.relkind in ('v','m') then pg_get_viewdef(c.oid, true) end
           from pg_class c where c.oid = {rel}"
    );
    let constraint_sql = format!(
        "select conname, pg_get_constraintdef(oid, true) from pg_constraint
          where conrelid = {rel} order by case contype when 'p' then 0 when 'u' then 1 when 'f' then 2 else 3 end, conname"
    );
    let plain_index_sql = format!(
        "select pg_get_indexdef(i.indexrelid) from pg_index i
          where i.indrelid = {rel} and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
          order by 1"
    );

    let (out_fk_sql, in_fk_sql) = (fk_sql(&format!("con.conrelid = {rel}")), fk_sql(&format!("con.confrelid = {rel}")));
    let (cols, idx, fks, refs, info, cons, plain) = tokio::try_join!(
        pool.text_rows(&columns_sql),
        pool.text_rows(&index_sql),
        pool.text_rows(&out_fk_sql),
        pool.text_rows(&in_fk_sql),
        pool.text_rows(&info_sql),
        pool.text_rows(&constraint_sql),
        pool.text_rows(&plain_index_sql),
    )?;

    let info = info.into_iter().next().ok_or_else(|| crate::error::msg(format!("Table {schema}.{table} not found")))?;
    let relkind = txt(&info, 0).unwrap_or_default();
    let is_view = relkind == "v" || relkind == "m";

    let columns: Vec<StructColumn> = cols
        .iter()
        .map(|r| {
            let identity = txt(r, 8).unwrap_or_default();
            let generated = txt(r, 9).unwrap_or_default();
            let extra = match (identity.as_str(), generated.as_str()) {
                ("a", _) => Some("GENERATED ALWAYS AS IDENTITY".to_string()),
                ("d", _) => Some("GENERATED BY DEFAULT AS IDENTITY".to_string()),
                (_, "s") => Some("GENERATED ALWAYS (stored)".to_string()),
                _ => None,
            };
            StructColumn {
                name: txt(r, 0).unwrap_or_default(),
                column_type: txt(r, 1).unwrap_or_default(),
                nullable: is_true(r, 2),
                default: txt(r, 3),
                primary_key: is_true(r, 4),
                auto_increment: is_true(r, 5),
                comment: txt(r, 6),
                collation: txt(r, 7),
                extra,
                // enum labels are joined with \u{1} (see the query)
                enum_values: txt(r, 10).map(|v| v.split('\u{1}').map(str::to_string).collect()),
            }
        })
        .collect();

    // Postgres has no SHOW CREATE TABLE, so the DDL is built from the catalog
    let ddl = if is_view {
        let kw = if relkind == "m" { "MATERIALIZED VIEW" } else { "VIEW" };
        format!("CREATE {kw} {}.{} AS\n{}", pg_ident(schema), pg_ident(table), txt(&info, 4).unwrap_or_default())
    } else {
        let mut lines: Vec<String> = columns
            .iter()
            .map(|c| {
                let mut l = format!("    {} {}", pg_ident(&c.name), c.column_type);
                if let Some(coll) = &c.collation {
                    l += &format!(" COLLATE {}", pg_ident(coll));
                }
                if let Some(e) = &c.extra {
                    if e.contains("IDENTITY") {
                        l += &format!(" {e}");
                    }
                }
                if let Some(d) = &c.default {
                    l += &format!(" DEFAULT {d}");
                }
                if !c.nullable {
                    l += " NOT NULL";
                }
                l
            })
            .collect();
        for r in &cons {
            lines.push(format!("    CONSTRAINT {} {}", pg_ident(&txt(r, 0).unwrap_or_default()), txt(r, 1).unwrap_or_default()));
        }
        let mut ddl = format!("CREATE TABLE {}.{} (\n{}\n);", pg_ident(schema), pg_ident(table), lines.join(",\n"));
        for r in &plain {
            ddl += &format!("\n\n{};", txt(r, 0).unwrap_or_default());
        }
        if let Some(c) = txt(&info, 3) {
            ddl += &format!("\n\nCOMMENT ON TABLE {}.{} IS {};", pg_ident(schema), pg_ident(table), pg_lit(&c));
        }
        for c in columns.iter().filter(|c| c.comment.is_some()) {
            ddl += &format!(
                "\nCOMMENT ON COLUMN {}.{}.{} IS {};",
                pg_ident(schema),
                pg_ident(table),
                pg_ident(&c.name),
                pg_lit(c.comment.as_deref().unwrap_or_default())
            );
        }
        ddl
    };

    Ok(TableStructure {
        schema: schema.into(),
        table: table.into(),
        is_view,
        columns,
        indexes: group_indexes(&idx),
        foreign_keys: group_fks(&fks, pg_rule),
        referenced_by: group_fks(&refs, pg_rule),
        ddl,
        engine: None,
        row_estimate: txt(&info, 1).filter(|n| n != "-1"),
        size_bytes: txt(&info, 2),
        table_comment: txt(&info, 3),
        collation: None,
    })
}


fn my_lit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

fn my_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

async fn load_my(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableStructure> {
    let (s, t) = (my_lit(schema), my_lit(table));
    let columns_sql = format!(
        "select column_name, column_type, is_nullable = 'YES', column_default, column_key = 'PRI',
                extra like '%auto_increment%', nullif(column_comment, ''), collation_name, nullif(extra, ''), data_type
           from information_schema.columns where table_schema = {s} and table_name = {t} order by ordinal_position"
    );
    let index_sql = format!(
        "select index_name, non_unique = 0, index_name = 'PRIMARY', index_type, coalesce(column_name, '(expression)'), false
           from information_schema.statistics where table_schema = {s} and table_name = {t}
          order by index_name = 'PRIMARY' desc, index_name, seq_in_index"
    );
    let fk_sql = |filter: String| {
        format!(
            "select k.constraint_name, k.table_schema, k.table_name, k.column_name, k.referenced_table_schema,
                    k.referenced_table_name, k.referenced_column_name, r.update_rule, r.delete_rule
               from information_schema.key_column_usage k
               join information_schema.referential_constraints r
                 on r.constraint_schema = k.constraint_schema and r.constraint_name = k.constraint_name and r.table_name = k.table_name
              where k.referenced_table_name is not null and {filter}
              order by k.table_name, k.constraint_name, k.ordinal_position"
        )
    };
    let info_sql = format!(
        "select table_type, engine, table_rows, data_length + index_length, nullif(table_comment, ''), table_collation
           from information_schema.tables where table_schema = {s} and table_name = {t}"
    );
    let ddl_sql = format!("show create table {}.{}", my_ident(schema), my_ident(table));

    let out_fk_sql = fk_sql(format!("k.table_schema = {s} and k.table_name = {t}"));
    let in_fk_sql = fk_sql(format!("k.referenced_table_schema = {s} and k.referenced_table_name = {t}"));
    let (cols, idx, fks, refs, info, ddl) = tokio::try_join!(
        pool.text_rows(&columns_sql),
        pool.text_rows(&index_sql),
        pool.text_rows(&out_fk_sql),
        pool.text_rows(&in_fk_sql),
        pool.text_rows(&info_sql),
        pool.text_rows(&ddl_sql),
    )?;

    let info = info.into_iter().next().ok_or_else(|| crate::error::msg(format!("Table {schema}.{table} not found")))?;
    let is_view = txt(&info, 0).as_deref() == Some("VIEW");

    let columns = cols
        .iter()
        .map(|r| {
            let extra = txt(r, 8);
            let generated_default = extra.as_deref().is_some_and(|e| e.contains("DEFAULT_GENERATED"));
            let data_type = txt(r, 9).unwrap_or_default();
            // MySQL returns defaults unquoted; turn them into SQL expressions
            let default = txt(r, 3).map(|d| {
                let numeric = matches!(
                    data_type.as_str(),
                    "tinyint" | "smallint" | "mediumint" | "int" | "bigint" | "decimal" | "float" | "double" | "bit" | "year"
                );
                if generated_default || numeric { d } else { my_lit(&d) }
            });
            let extra = extra
                .map(|e| e.replace("DEFAULT_GENERATED", "").replace("auto_increment", "").trim().to_string())
                .filter(|e| !e.is_empty());
            let column_type = txt(r, 1).unwrap_or_default();
            StructColumn {
                name: txt(r, 0).unwrap_or_default(),
                enum_values: mysql_enum_values(&column_type),
                column_type,
                nullable: is_true(r, 2),
                default,
                primary_key: is_true(r, 4),
                auto_increment: is_true(r, 5),
                comment: txt(r, 6),
                collation: txt(r, 7),
                extra,
            }
        })
        .collect();

    Ok(TableStructure {
        schema: schema.into(),
        table: table.into(),
        is_view,
        columns,
        indexes: group_indexes(&idx),
        foreign_keys: group_fks(&fks, |c| c.unwrap_or("NO ACTION").to_string()),
        referenced_by: group_fks(&refs, |c| c.unwrap_or("NO ACTION").to_string()),
        ddl: ddl.first().and_then(|r| txt(r, 1)).map(|d| format!("{d};")).unwrap_or_default(),
        engine: txt(&info, 1),
        row_estimate: txt(&info, 2),
        size_bytes: txt(&info, 3),
        table_comment: txt(&info, 4),
        collation: txt(&info, 5),
    })
}

/// Values of MySQL `enum('a','b')` / `set('x','y')`; quotes inside are doubled.
fn mysql_enum_values(column_type: &str) -> Option<Vec<String>> {
    let lower = column_type.to_ascii_lowercase();
    if !(lower.starts_with("enum(") || lower.starts_with("set(")) {
        return None;
    }
    let inner = &column_type[column_type.find('(')? + 1..column_type.rfind(')')?];
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_str = false;
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if in_str && chars.peek() == Some(&'\'') => {
                cur.push('\'');
                chars.next();
            }
            '\'' if in_str => {
                in_str = false;
                out.push(std::mem::take(&mut cur));
            }
            '\'' => in_str = true,
            c if in_str => cur.push(c),
            _ => {}
        }
    }
    Some(out)
}


fn txt(row: &[Cell], i: usize) -> Option<String> {
    row.get(i).cloned().flatten()
}

fn is_true(row: &[Cell], i: usize) -> bool {
    matches!(row.get(i).and_then(|c| c.as_deref()), Some("true" | "1" | "t"))
}

/// Rows (name, unique, primary, method, column, constraint) -> one index per name.
fn group_indexes(rows: &[Vec<Cell>]) -> Vec<StructIndex> {
    let mut out: Vec<StructIndex> = Vec::new();
    for r in rows {
        let (name, unique, primary, method, col) = (txt(r, 0).unwrap_or_default(), is_true(r, 1), is_true(r, 2), txt(r, 3), txt(r, 4));
        match out.last_mut() {
            Some(last) if last.name == name => last.columns.extend(col),
            _ => out.push(StructIndex {
                name,
                columns: col.into_iter().collect(),
                unique,
                primary,
                method: method.unwrap_or_default().to_uppercase(),
                constraint: is_true(r, 5),
            }),
        }
    }
    out
}

/// Rows (name, schema, table, column, ref schema/table/column, on update, on delete) -> FKs.
fn group_fks(rows: &[Vec<Cell>], rule: impl Fn(Option<&str>) -> String) -> Vec<StructForeignKey> {
    let mut map: BTreeMap<(String, String, String), StructForeignKey> = BTreeMap::new();
    for r in rows {
        let key = (txt(r, 1).unwrap_or_default(), txt(r, 2).unwrap_or_default(), txt(r, 0).unwrap_or_default());
        let fk = map.entry(key.clone()).or_insert_with(|| StructForeignKey {
            name: key.2.clone(),
            table_schema: key.0.clone(),
            table: key.1.clone(),
            columns: Vec::new(),
            ref_schema: txt(r, 4).unwrap_or_default(),
            ref_table: txt(r, 5).unwrap_or_default(),
            ref_columns: Vec::new(),
            on_update: rule(r.get(7).and_then(|c| c.as_deref())),
            on_delete: rule(r.get(8).and_then(|c| c.as_deref())),
        });
        fk.columns.extend(txt(r, 3));
        fk.ref_columns.extend(txt(r, 6));
    }
    map.into_values().collect()
}
