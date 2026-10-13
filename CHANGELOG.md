# Changelog

Every release has a section here. The release workflow copies the section of the version being
built into the GitHub release notes (and the in-app update prompt links to them), so a version
without a section won't build.

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
  all from the same moment of the database, and compressed in parallel: about 4–5× faster
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
