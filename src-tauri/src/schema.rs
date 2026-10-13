//! Database objects (schemas, tables, views, routines...) for the tree and autocomplete.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::db::{Cell, DbPool};
use crate::error::AppResult;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    /// pg_catalog, information_schema, mysql...
    pub system: bool,
    pub tables: Vec<String>,
    pub views: Vec<String>,
    pub mat_views: Vec<String>,
    pub functions: Vec<String>,
    pub procedures: Vec<String>,
    pub triggers: Vec<String>,
    /// Table sizes and estimated row counts from server statistics (no counting)
    pub table_stats: BTreeMap<String, TableStat>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStat {
    /// None if the table hasn't been analyzed yet
    pub rows: Option<i64>,
    pub data_bytes: i64,
    pub index_bytes: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub schema: String,
    pub table: String,
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTree {
    pub schemas: Vec<SchemaInfo>,
    /// Columns of user schemas only.
    pub columns: Vec<ColumnInfo>,
}

const PG_SCHEMAS: &str = "select nspname from pg_namespace \
    where nspname not like 'pg\\_toast%' and nspname not like 'pg\\_temp%' order by nspname";

const PG_OBJECTS: &str = "\
select n.nspname, case when c.relkind in ('r','p') then 'table' when c.relkind = 'v' then 'view' else 'matview' end, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r','p','v','m')
union all
select n.nspname, case p.prokind when 'p' then 'procedure' else 'function' end, p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.prokind in ('f','p')
union all
select n.nspname, 'trigger', t.tgname
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where not t.tgisinternal";

const PG_COLUMNS: &str = "\
select n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), not a.attnotnull
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
 where a.attnum > 0 and not a.attisdropped and c.relkind in ('r','p','v','m')
   and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\\_%'
 order by n.nspname, c.relname, a.attnum";

const PG_STATS: &str = "select n.nspname, c.relname, case when c.reltuples < 0 then null else c.reltuples::bigint end,
       pg_table_size(c.oid), pg_indexes_size(c.oid)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r','p','m')";

const MY_SYSTEM: &[&str] = &["information_schema", "mysql", "performance_schema", "sys"];

const MY_SCHEMAS: &str = "select schema_name from information_schema.schemata order by schema_name";

const MY_OBJECTS: &str = "\
select table_schema, case table_type when 'VIEW' then 'view' else 'table' end, table_name from information_schema.tables
union all
select routine_schema, lower(routine_type), routine_name from information_schema.routines
union all
select trigger_schema, 'trigger', trigger_name from information_schema.triggers";

const MY_STATS: &str = "select table_schema, table_name, table_rows, coalesce(data_length, 0), coalesce(index_length, 0)
  from information_schema.tables where table_type = 'BASE TABLE'";

const MY_COLUMNS: &str = "\
select table_schema, table_name, column_name, column_type, is_nullable = 'YES'
  from information_schema.columns
 where table_schema not in ('information_schema','mysql','performance_schema','sys')
 order by table_schema, table_name, ordinal_position";

pub async fn load(pool: &DbPool) -> AppResult<SchemaTree> {
    let (schemas_sql, objects_sql, columns_sql, stats_sql) = match pool {
        DbPool::Pg(_) => (PG_SCHEMAS, PG_OBJECTS, PG_COLUMNS, PG_STATS),
        DbPool::My(_) => (MY_SCHEMAS, MY_OBJECTS, MY_COLUMNS, MY_STATS),
    };
    let is_system = |name: &str| match pool {
        DbPool::Pg(_) => name == "pg_catalog" || name == "information_schema",
        DbPool::My(_) => MY_SYSTEM.contains(&name),
    };

    // Statistics are optional: without rights (or on error) the tree still loads.
    let (schema_rows, object_rows, column_rows, stat_rows) = tokio::try_join!(
        pool.text_rows(schemas_sql),
        pool.text_rows(objects_sql),
        pool.text_rows(columns_sql),
        async { Ok(pool.text_rows(stats_sql).await.unwrap_or_default()) },
    )?;

    let mut by_name: BTreeMap<String, SchemaInfo> = schema_rows
        .into_iter()
        .filter_map(|r| text(&r, 0))
        .map(|name| {
            let info = SchemaInfo { system: is_system(&name), name: name.clone(), ..Default::default() };
            (name, info)
        })
        .collect();

    for row in object_rows {
        let (Some(schema), Some(kind), Some(name)) = (text(&row, 0), text(&row, 1), text(&row, 2)) else {
            continue;
        };
        let Some(info) = by_name.get_mut(&schema) else { continue };
        let list = match kind.as_str() {
            "table" => &mut info.tables,
            "view" => &mut info.views,
            "matview" => &mut info.mat_views,
            "function" => &mut info.functions,
            "procedure" => &mut info.procedures,
            "trigger" => &mut info.triggers,
            _ => continue,
        };
        list.push(name);
    }

    let num = |row: &[Cell], i: usize| text(row, i).and_then(|v| v.parse::<i64>().ok());
    for row in stat_rows {
        let (Some(schema), Some(name)) = (text(&row, 0), text(&row, 1)) else { continue };
        let Some(info) = by_name.get_mut(&schema) else { continue };
        let stat = TableStat { rows: num(&row, 2), data_bytes: num(&row, 3).unwrap_or(0), index_bytes: num(&row, 4).unwrap_or(0) };
        info.table_stats.insert(name, stat);
    }

    let mut schemas: Vec<SchemaInfo> = by_name.into_values().collect();
    for s in &mut schemas {
        for list in [&mut s.tables, &mut s.views, &mut s.mat_views, &mut s.functions, &mut s.procedures, &mut s.triggers] {
            list.sort_unstable();
            list.dedup(); // overloaded functions share a name
        }
    }
    // User schemas first ("public" on top), then system ones.
    schemas.sort_by_key(|s| (s.system, s.name != "public", s.name.clone()));

    let columns = column_rows
        .into_iter()
        .filter_map(|r| {
            Some(ColumnInfo {
                schema: text(&r, 0)?,
                table: text(&r, 1)?,
                name: text(&r, 2)?,
                data_type: text(&r, 3).unwrap_or_default(),
                nullable: matches!(text(&r, 4).as_deref(), Some("true" | "1")),
            })
        })
        .collect();

    Ok(SchemaTree { schemas, columns })
}

fn text(row: &[Cell], i: usize) -> Option<String> {
    row.get(i).cloned().flatten()
}
