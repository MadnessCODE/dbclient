# Changelog

Every release has a section here. The release workflow copies the section of the version being
built into the GitHub release notes, so a version without a section won't build. The website's
What's new page (site/whats-new.html, linked from the app) shows this file too.

How to write a section so it looks good on both:
- `> One line` right under the version heading is the release's summary.
- A bigger feature gets its own `#### Title` under `### New`, a short description, screenshots
  (`npm run shots` saves them to `site/releases/<version>/`; link them with the full
  `https://madnesscode.github.io/dbclient/releases/...` URL) and a `**How to use it**` paragraph
  followed by numbered steps.
- Smaller changes stay one bullet each.

## 0.1.7

> Filter results with a click instead of writing WHERE, see which queries slow a table down and
> what index would fix them, and read execution plans as a tree.

### New

#### Grid filters
Narrow down any result without touching the SQL. Pick a column, choose a condition and the
query runs again in the database with your filter, so it searches the whole table, not just the
rows on screen. Filters work with database sorting, export and editing, and stay as long as you
re-run the same query.

![Filter chips above the results, with the generated WHERE below them](https://madnesscode.github.io/dbclient/releases/0.1.7/grid-filters.png)

The filter adapts to the column: text (contains, starts with, in a list), numbers, dates with a
picker and quick ranges like *last 7 days*, Unix timestamps shown as dates, booleans, enums and
sets. It also lists the column's most common values: click one to filter by it.

![Editing a filter: conditions and the most common values of the column](https://madnesscode.github.io/dbclient/releases/0.1.7/grid-filter-popover.png)

**How to use it**
1. Run a query, then click **+ Filter** above the results and pick a column. Or right-click a
   cell and choose *= value*, *≠ value*, *is null*…, or `Alt`+click a value to filter by it.
2. Click a filter chip to change it, or its **×** to remove it. Switch between **AND** and
   **OR** when you have several.
3. Need something special? Type a condition in the **WHERE** box, with column completion.
4. **To editor** writes the filtered query into the editor; **Clear** removes all filters.

#### Slow queries and index suggestions
Table Doctor now shows the statements that use the table the most: how often they run, how long
they take in total and on average. Click one to open it in a new tab with its plan.

From the plans of those statements it suggests indexes that would help, with the reason, the
numbers and the `CREATE INDEX` ready to run through the usual preview and production check. It
skips columns that already have an index and columns with only a few distinct values, where an
index wouldn't help.

![The slowest statements on a table and the indexes that would help](https://madnesscode.github.io/dbclient/releases/0.1.7/slow-queries.png)

On PostgreSQL with the **hypopg** extension, **What if?** shows what an index would change
before you create it: the plan is calculated as if the index existed, and nothing is created and
no query runs.

![What if: the query cost with the index, before creating it](https://madnesscode.github.io/dbclient/releases/0.1.7/what-if.png)

**How to use it**
1. Right-click a table → **Analyze table** and scroll to **Slow queries**.
2. Click a statement to see its plan, or open a suggested index to see why it helps.
3. **What if?** (PostgreSQL with hypopg) shows the cost before and after; **Create index…** builds
   it in the background.
4. Statistics not on yet? The section says what's missing (`pg_stat_statements` on PostgreSQL,
   `performance_schema` on MySQL) and offers an **Enable…** button with the SQL that turns it on,
   when that can be done from a connection.

#### Visual Explain
**Explain** now draws the plan as a tree: every step with its share of the cost (or the time),
estimated rows, and warnings where something looks wrong: a whole table read for a few rows,
estimates off by 10× or more, a sort or hash spilling to disk, a nested loop over many rows, a
MySQL join without an index. The most expensive steps are highlighted. **Raw** still shows the
plan as text.

![An analyzed plan with timings, row estimates and warnings](https://madnesscode.github.io/dbclient/releases/0.1.7/visual-explain.png)

**How to use it**
1. In a query tab press **Explain** (`Ctrl+E`) to see the plan without running anything.
2. On PostgreSQL, **Explain Analyze** runs the statement to show real times and row counts. It
   runs inside a transaction that is always rolled back, so nothing changes; statements that
   modify data ask first.
3. Click a step to see its conditions, keys, sort method and buffers.

### Fixed
- Queries that start with a comment (`-- what this does`) can now be filtered, sorted in the
  database and exported with all rows.
- An empty filtered result keeps the grid and its columns, so you can change the filter.
- Explain only explains one statement at a time.

## 0.1.6

> Table Doctor finds what slows a table down and fixes it with one click, for one table or the
> whole database.

### New

#### Table Doctor
Right-click a table and DB Client tells you what's wrong with it and how to fix it: a health
score, the key numbers at a glance (rows, size, dead rows, sequential scans, last ANALYZE) and a
list of findings sorted by severity. Each finding explains the problem in plain words, shows the
numbers behind it and, where there is one, the fix as SQL you can read before you run it.

It checks dead rows and autovacuum, tables read mostly by full scans, unused, duplicate and
redundant indexes, foreign keys without an index, tables without a primary key, missing or
old statistics, wasted space, money stored as a float, and on MySQL also fragmentation, MyISAM
tables and join columns whose type or collation doesn't match. It only reads catalog and
statistics views, so analyzing is safe on production.

![Table Doctor for one table: score, key numbers and findings](https://madnesscode.github.io/dbclient/releases/0.1.6/table-doctor.png)

**How to use it**
1. Right-click a table in the tree and choose **Analyze table**.
2. Click a finding to see the explanation, the evidence and the fix.
3. Click the fix button (**Vacuum…**, **Create index…**, **Drop index…**, …). The SQL opens
   for review; you can edit it. On a production connection you also tick a confirmation.
4. The fix runs in the background (see **Tasks**), the table is analyzed again when it's done.
   Long ones like `CREATE INDEX CONCURRENTLY` or `VACUUM` never block the app.
5. Something you know about and want to keep? **Ignore** it: it leaves the score and the list
   and waits under **Ignored** in case you change your mind.

![Every fix is shown as SQL before it runs](https://madnesscode.github.io/dbclient/releases/0.1.6/table-doctor-fix.png)

Below the findings: every index with its size and how often it's used (green used, amber rarely,
red never), how the table's space splits into live rows, dead rows and free space, and
**Column values**. Pick a column to see its NULL share, distinct values and most common values,
and why an index on a column like `status` with a few values doesn't help most queries.

![Index usage, table space and column values](https://madnesscode.github.io/dbclient/releases/0.1.6/table-doctor-columns.png)

#### Health dots in the tree
Tables with a problem get a dot in the schema tree: red for critical, amber for a warning.
Hover it for the count, click it to open Table Doctor. The dots come from one quick read of the
schema's statistics and refresh after a fix. Don't want them? **Settings → Table health dots**.

![Red and amber dots next to tables with findings](https://madnesscode.github.io/dbclient/releases/0.1.6/tree-dots.png)

#### Database Doctor
The same checks for every table at once, with the biggest problems first: findings are ranked
by severity and table size, so a critical issue on a 200 MB table comes before a warning on a
small one. Filter by severity or table name, fix right from the list, or open a table's own
Table Doctor.

![Top issues across a whole database](https://madnesscode.github.io/dbclient/releases/0.1.6/database-doctor.png)

**How to use it**
1. Right-click a schema and choose **Analyze schema** (on MySQL: a database, **Analyze
   database**). For all schemas of a PostgreSQL database, right-click the database or the
   connection and choose **Analyze database**.
2. The scan runs in the background with progress; you can keep working.
3. Click a table name to open its Table Doctor, or use the fix buttons right there.

### PostgreSQL
- **Create database** dialog: template (or copy any database with its data), owner, encoding,
  locale provider, collation, ICU locale, tablespace, connection limit and more, showing only
  what your server version supports.
- **Rename a database** from the tree. Open sessions are closed first (with a confirmation on
  production) and your open tabs follow the new name.
- **Users & privileges** on a server connection covers every database: see where a user has
  access, edit privileges per database and apply them together.
- Columns of extension types like `citext` and `hstore` show their type name instead of `?`.

### MySQL
- Each query tab has its own database, picked next to the connection. Tables opened from the
  tree are written without the database prefix (`FROM orders`), and `USE db;` in the editor
  switches the tab's database.

### Changed
- **Save** and **Save as…** moved from the editor toolbar to the tab's and the editor's
  right-click menus; `Ctrl+S` still saves.
- The Structure tab reads tables from the tab's own database on PostgreSQL server connections
  and has a nicer table picker.

## 0.1.5

> Save the queries you use every day, read Unix timestamps at a glance, and work in one schema
> at a time.

### New

#### Favorite queries
Keep the queries you run over and over one click away. Give them a name, sort them into
categories and find them again from the query editor by name or by any part of the SQL.
Favorites are shared by all connections, so the same query works on development, staging and
production: it always runs on the connection of the tab you insert it into.

![The Favorites dropdown in the query editor](https://madnesscode.github.io/dbclient/releases/0.1.5/favorites-picker.png)

**How to use it**
1. Select a query in the editor (or just put the cursor in it), right-click and choose
   **Add to favorites**. Without a selection the statement under the cursor is saved.
2. Name it, pick a category or create one with **New category…**, and save.
3. Click **Favorites** in the editor toolbar. Type to search, open a category, then click a
   favorite (or press `Enter`) to insert it at the cursor. `Shift+Enter` opens it in a new tab.
4. Right-click a favorite to replace the editor's content, run it, copy it, edit it, move it to
   another category or delete it. Rename or delete a category with the icons next to its name.

![Add to favorites in the editor's right-click menu](https://madnesscode.github.io/dbclient/releases/0.1.5/favorites-add.png)

![Naming a favorite and choosing its category](https://madnesscode.github.io/dbclient/releases/0.1.5/favorites-dialog.png)

Favorites also show up in the search (`Ctrl+K`), and every run in a tab's **History** has a
star to save it.

#### Unix timestamps in the grid
Integer columns that hold Unix timestamps (seconds or milliseconds, like `created_at` or
`last_login`) are recognized by their name and values. Hover a value to see the date and time,
how long ago it was, your local time with its time zone and UTC. Double-click it to pick a new
date and time in the calendar: it's saved back as the same kind of number.

![Hovering a Unix timestamp shows the date](https://madnesscode.github.io/dbclient/releases/0.1.5/timestamp-tip.png)

**How to use it**
1. Run a query on a table with a timestamp column, for example `created_at` stored as `bigint`.
2. Hover a value in that column for a moment to see the date card.
3. Double-click the value (in an editable result) to open the date picker, choose a day and
   time, and click **Apply**. Typing a digit still edits the raw number.

![Editing a Unix timestamp with the date picker](https://madnesscode.github.io/dbclient/releases/0.1.5/timestamp-picker.png)

#### Focus on one schema
Big servers have long trees. Focus shows a single schema alone in the left panel with its
tables already open, and lets you switch schema or database from the header without going
back to the full tree.

![A focused schema in the left panel](https://madnesscode.github.io/dbclient/releases/0.1.5/schema-focus.png)

**How to use it**
1. Hover a schema in the tree and click the target icon next to it, or right-click the schema
   and choose **Focus**.
2. Click the schema name in the header to switch to another one.
3. Click the arrow at the top left to go back to all connections. **Back to …** above the tree
   returns you to the focused schema.
4. Prefer it as the default? **Settings → Clicking a schema → Opens it in focus**.

#### Truncate or empty a whole schema or database
Clear test data in two clicks: **Truncate** deletes all rows and keeps the tables, **Empty**
drops every table, view and routine and keeps the schema or database itself. You type its name
to confirm, and both are hidden on connections marked as production.

![Truncate and Empty in the schema's menu](https://madnesscode.github.io/dbclient/releases/0.1.5/schema-menu.png)

**How to use it**
1. Right-click a schema (PostgreSQL) or a database (MySQL, or PostgreSQL from the database
   list).
2. Choose **Truncate schema…** or **Empty schema…**, type the name and confirm.

### Import
- **pg_dump custom format (`-Fc`) imports directly.** No `pg_restore` needed, and it uses the
  same parallel importer. An option skips ownership (`ALTER … OWNER TO`) when the users don't
  exist on the target server.
- **Auto parallelism.** Imports start with a few connections and add or remove them by the
  measured throughput, so a busy or small server isn't flooded. Switch to **Manual** to set the
  number yourself.
- **Stop** shows *Stopping…* until the import or export has really ended.

## 0.1.4

### New
- **Import connections from Sequel Ace and Sequel Pro** (macOS): favorites with their groups,
  SSH tunnels, SSL and colors, found automatically or read from an exported `.plist` file.
  Passwords stay in the macOS keychain, so you enter them on first connect.

### Fixed
- **Sorting a limited result now sorts in the database.** When a query has a `LIMIT` (like
  *Open (first 100 rows)*) or hits the Max rows setting, clicking a column header re-runs it with
  `ORDER BY`, so you get the real first or last rows of the table instead of just the loaded
  ones in a different order. Results that are fully loaded are still sorted instantly in the grid.

## 0.1.3

### New
- **Import connections from other tools.** DB Client finds the connections you already have in
  DBeaver, pgAdmin 4, MySQL Workbench and `.pgpass` (or reads an exported file) and brings
  them over in one click: host, port, user, database, SSL, SSH tunnel, environment, and folders
  or server groups as projects. Saved passwords come along from DBeaver and `.pgpass`;
  duplicates are recognized and skipped.
- **Export a whole database or schema** into one `.sql` or `.sql.gz` file: right-click a
  database or schema → *Export…*. Structure and data, structure only or data only, optional
  DROP statements. Tables are read over several connections at once (big ones in key ranges),
  all from the same moment of the database, and compressed in parallel: about 5× faster
  than `pg_dump` and `mysqldump` on a 350 MB test database. The file loads with our Import,
  `psql` or `mysql`, and runs in the background like imports.
- **ER diagrams.** Right-click a schema (or a MySQL database) → *ER diagram…* to see its tables,
  views and relationships: drag tables around, zoom, search, click a table for its columns, keys
  and indexes, or switch to *Documentation*. **Export HTML** saves everything as one file that
  opens in any browser, offline, with your arrangement, ready to send to the team.
- The app checks for updates while it runs (every few hours), not only at startup. "Later"
  hides a version until the next start.
- "What's new" links in the update prompt and in About, and a short note after the app updates.

## 0.1.2

### New
- **All PostgreSQL databases in the tree.** When a connection has no default database, every
  database on the server is listed with its size and opens on its own: tabs, import, `Ctrl+K`
  and the connection picker work per database. Create and drop databases from the tree.
- **Linux builds** for x64 and ARM64: AppImage (updates itself), `.deb` and `.rpm`.
- **Resizable result columns.** Drag a header edge, double-click it to fit the content, or
  right-click a header to reset widths.
- **New SQL editor menu** on right click, in the app's style, with icons and shortcuts:
  run, explain, format, clipboard, comment and more.

### Fixed
- PostgreSQL connections without a database tried to open one named after the user.
- Dropdown menus in the editor toolbar were cut off by the panels below.
- The About logo was clipped while it bounced.

## 0.1.1

### Fixed
- macOS: a blank window on older systems. The app now targets older WebKit versions and shows
  the actual error instead of a blank window if it can't start.
- The website showed the previous release for a minute after a new one was published.

## 0.1.0

First public beta: PostgreSQL and MySQL connections with SSH tunnels, SQL editor, editable
results grid, structure editor, parallel import and export, users and privileges, process
monitor, Windows and macOS installers with auto-update.
