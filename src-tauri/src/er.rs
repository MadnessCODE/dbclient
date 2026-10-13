//! Schema model for ER diagrams: every table and view of one schema with columns, keys,
//! indexes and comments, loaded in a few queries.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::db::{Cell, DbPool};
use crate::error::AppResult;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErTable {
    pub name: String,
    /// "table" or "view"
    pub kind: String,
    pub comment: Option<String>,
    pub columns: Vec<ErColumn>,
    pub indexes: Vec<ErIndex>,
    pub foreign_keys: Vec<ErForeignKey>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub primary_key: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErIndex {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_delete: String,
    pub on_update: String,
}

fn lit(s: &str, mysql: bool) -> String {
    let s = s.replace('\'', "''");
    format!("'{}'", if mysql { s.replace('\\', "\\\\") } else { s })
}

fn text(c: &Cell) -> String {
    c.clone().unwrap_or_default()
}

fn opt(c: &Cell) -> Option<String> {
    c.clone().filter(|s| !s.is_empty())
}

fn flag(c: &Cell) -> bool {
    matches!(c.as_deref(), Some("t" | "true" | "1" | "YES"))
}

fn pg_action(c: &Cell) -> String {
    match c.as_deref() {
        Some("c") => "CASCADE",
        Some("n") => "SET NULL",
        Some("d") => "SET DEFAULT",
        Some("r") => "RESTRICT",
        _ => "NO ACTION",
    }
    .into()
}

pub async fn load(pool: &DbPool, schema: &str) -> AppResult<Vec<ErTable>> {
    let mysql = matches!(pool, DbPool::My(_));
    let s = lit(schema, mysql);
    let (cols, fks, idx) = if mysql {
        (
            format!(
                "select c.table_name, if(t.table_type = 'VIEW', 'view', 'table'), t.table_comment, c.column_name, c.column_type,
                        c.is_nullable = 'YES', c.column_default, c.column_key = 'PRI', c.column_comment
                   from information_schema.columns c
                   join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
                  where c.table_schema = {s}
                  order by c.table_name, c.ordinal_position"
            ),
            format!(
                "select k.constraint_name, k.table_name, k.column_name, k.referenced_table_schema, k.referenced_table_name,
                        k.referenced_column_name, r.delete_rule, r.update_rule
                   from information_schema.key_column_usage k
                   join information_schema.referential_constraints r
                     on r.constraint_schema = k.constraint_schema and r.constraint_name = k.constraint_name and r.table_name = k.table_name
                  where k.table_schema = {s} and k.referenced_table_name is not null
                  order by k.table_name, k.constraint_name, k.ordinal_position"
            ),
            format!(
                "select table_name, index_name, non_unique = 0, index_name = 'PRIMARY', coalesce(column_name, '(expression)')
                   from information_schema.statistics
                  where table_schema = {s}
                  order by table_name, index_name, seq_in_index"
            ),
        )
    } else {
        (
            format!(
                "select c.relname, case when c.relkind in ('v','m') then 'view' else 'table' end, obj_description(c.oid, 'pg_class'),
                        a.attname, format_type(a.atttypid, a.atttypmod), not a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
                        exists (select 1 from pg_constraint p where p.conrelid = c.oid and p.contype = 'p' and a.attnum = any (p.conkey)),
                        col_description(c.oid, a.attnum)
                   from pg_class c
                   join pg_namespace n on n.oid = c.relnamespace
                   join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                   left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
                  where n.nspname = {s} and c.relkind in ('r','p','v','m')
                  order by c.relname, a.attnum"
            ),
            format!(
                "select k.conname, cl.relname, a.attname, fn.nspname, fcl.relname, fa.attname, k.confdeltype, k.confupdtype
                   from pg_constraint k
                   join pg_class cl on cl.oid = k.conrelid
                   join pg_namespace n on n.oid = cl.relnamespace
                   join pg_class fcl on fcl.oid = k.confrelid
                   join pg_namespace fn on fn.oid = fcl.relnamespace
                   cross join lateral unnest(k.conkey, k.confkey) with ordinality as u(col, fcol, ord)
                   join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.col
                   join pg_attribute fa on fa.attrelid = k.confrelid and fa.attnum = u.fcol
                  where k.contype = 'f' and n.nspname = {s}
                  order by cl.relname, k.conname, u.ord"
            ),
            format!(
                "select t.relname, i.relname, x.indisunique, x.indisprimary, pg_get_indexdef(x.indexrelid, g.ord, true)
                   from pg_index x
                   join pg_class t on t.oid = x.indrelid
                   join pg_class i on i.oid = x.indexrelid
                   join pg_namespace n on n.oid = t.relnamespace
                   cross join lateral generate_series(1, x.indnkeyatts::int) as g(ord)
                  where n.nspname = {s}
                  order by t.relname, i.relname, g.ord"
            ),
        )
    };

    let mut tables: BTreeMap<String, ErTable> = BTreeMap::new();
    for r in pool.text_rows(&cols).await? {
        let name = text(&r[0]);
        let t = tables.entry(name.clone()).or_insert_with(|| ErTable { name, kind: text(&r[1]), comment: opt(&r[2]), ..Default::default() });
        t.columns.push(ErColumn {
            name: text(&r[3]),
            data_type: text(&r[4]),
            nullable: flag(&r[5]),
            default: r[6].clone(),
            primary_key: flag(&r[7]),
            comment: opt(&r[8]),
        });
    }

    for r in pool.text_rows(&fks).await? {
        let Some(t) = tables.get_mut(&text(&r[1])) else { continue };
        let name = text(&r[0]);
        let (on_delete, on_update) = if mysql { (text(&r[6]), text(&r[7])) } else { (pg_action(&r[6]), pg_action(&r[7])) };
        match t.foreign_keys.last_mut() {
            Some(fk) if fk.name == name => {
                fk.columns.push(text(&r[2]));
                fk.ref_columns.push(text(&r[5]));
            }
            _ => t.foreign_keys.push(ErForeignKey {
                name,
                columns: vec![text(&r[2])],
                ref_schema: text(&r[3]),
                ref_table: text(&r[4]),
                ref_columns: vec![text(&r[5])],
                on_delete,
                on_update,
            }),
        }
    }

    for r in pool.text_rows(&idx).await? {
        let Some(t) = tables.get_mut(&text(&r[0])) else { continue };
        let name = text(&r[1]);
        match t.indexes.last_mut() {
            Some(ix) if ix.name == name => ix.columns.push(text(&r[4])),
            _ => t.indexes.push(ErIndex { name, columns: vec![text(&r[4])], unique: flag(&r[2]), primary: flag(&r[3]) }),
        }
    }

    Ok(tables.into_values().collect())
}
