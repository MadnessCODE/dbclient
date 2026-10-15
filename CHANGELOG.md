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
