# Design: the web app (Stage 4.4)

**Status:** built 2026-10-18 and checked by hand in a browser against the local test-lab store: logging in, every page, and creating and revoking an API key. The full suite passes (369 tests).
**Code:** `src/lumida/web/` (`index.html`, `app.js`, `app.css`, logo). It's served by the API (`api/app.py`), with cookie login in `api/auth.py`.

## 1. Goal
People work with Lumida in a browser instead of a terminal. They see how healthy each database is, go through the problems, confirm or reject them, approve AI-proposed rules, and answer Lumida's questions. Admins manage people and read the audit log.

## 2. Decisions
| | Decision |
|---|---|
| **Technology** | plain HTML, CSS and JavaScript (ES modules), the same as the website. There's no framework, no build step and no Node.js in the image: the files ship inside the Python package and the API serves them at `/`. |
| **One address** | the web app and the API share `http://<host>:8000`. Page addresses use `#` (`#/s/shop/rules`), so there's nothing extra to configure on the server. |
| **Login in the browser** | `POST /auth/login` with `cookie: true` puts the session in an **HttpOnly, SameSite=Strict** cookie. Page scripts can't read it, and the browser doesn't send it with requests that start on other sites. It's marked `Secure` automatically behind HTTPS. Scripts keep using tokens and API keys. |
| **CSRF** | a change (anything but GET) made with the cookie must also send `X-Lumida-CSRF: 1`. Another website can't add that header without our permission, and no cross-origin access (CORS) is configured. Without it the answer is 403. |
| **No injected markup** | every value from the API goes onto the page as text (`textContent`), never as HTML. |
| **Content Security Policy** | web pages are served with `script-src 'self'` (no inline scripts, nothing from other sites), `frame-ancestors 'none'` (never inside another site's frame), `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. The API docs page (`/api/docs`) keeps its own. |
| **Role-aware** | buttons appear only for people allowed to use them: reviewers see review buttons, admins see People and Audit log. The API checks the role again anyway. |
| **Small screens** | it works at phone width; on narrow screens the header scrolls away instead of covering the page. |

## 3. Pages
| Address | What |
|---|---|
| `#/login` | email + password |
| `#/` | every database: health score, open problems by severity, last run, schedule |
| `#/s/<name>` | **Problems**, filtered by status, severity and kind, paged, with the health panel (schemas, worst tables, change since the previous run) |
| `#/s/<name>/rules` | rules, proposed first: approve, reject, disable, enable, reconsider; the definition and the AI's reasoning |
| `#/s/<name>/relationships` | links between tables (declared or inferred, confidence, AI opinion): confirm or reject |
| `#/s/<name>/questions` | Lumida's questions with a suggested answer: answer or "don't know" |
| `#/s/<name>/runs` | the last 30 nightly runs |
| `#/f/<id>` | one problem: description, evidence, AI explanation, history, and the review buttons with a note |
| `#/people` | admins: add people, change roles, disable or enable, reset passwords |
| `#/audit` | admins: the audit log, filtered by kind, paged |
| `#/me` | my API keys (made, shown once, revoked) and changing my password |

## 4. Tests
- **Automated:**
  - cookie login (HttpOnly, SameSite=Strict, no token in the answer)
  - a change without the CSRF header is refused (403) and allowed with it
  - logging out clears the session
  - the page is served with the strict policy and no inline scripts; every asset loads
  - `/api/docs` isn't affected
- **By hand** (2026-10-18, in the browser pane, against the local store with four lab databases):
  - logging in and the overview (scores, problem counts)
  - a database's problems with the health panel (its bars work under the strict policy)
  - the problem detail
  - rules, relationships, questions, runs
  - people, audit log, my account
  - an API key created and revoked from the browser
  - fixed along the way: on phone-width screens the sticky header covered the page

**Since 4.6:** the website's "Luminous Void" look and the aperture logo; a *Settings* tab for admins (schedule, schemas, pause, remove); *Download as YAML* on the Rules tab. See [`rules_as_code.md`](rules_as_code.md).

## 4b. The redesign with charts (2026-11-04)
Rebuilt from the user's Stitch screens (Overview, Database detail, Problems, Problem detail, Add a database), in the same plain HTML/CSS/JS and under the same strict policy.
- **Layout:** a left sidebar (database switcher; Overview, Databases, Problems, Rules, Relationships, Questions, Runs; People, Audit log, My account) and a top bar (breadcrumb, search, Run now, account menu). On phones the sidebar folds into a Menu button.
- **Charts** (`web/charts.js`): small SVG drawn with `createElementNS`, no library, nothing loaded from elsewhere; hover hints are `<title>` elements. Lines, stacked columns, stacked areas, sparklines, a score ring, and the map of a table's links.
- **New endpoint** `GET /sources/{name}/history` feeds them (health and open problems per run, row counts per table); `GET /sources` gained counts by kind and the number of tables.

| Address | What |
|---|---|
| `#/` | **Overview**: overall health (with its trend), open problems (by severity, change since the last run), awaiting review (proposed rules and links), runs today; health by database; health over time (one line per database); open problems by kind per database; worst tables; latest problems |
| `#/databases` (`/add`) | every database as a table (kind, health, tables, open problems, schedule, last run); **Add a database** opens a side drawer (kind as a segmented control, connection by .env name, read-only login script, Test connection, run right after) |
| `#/problems` | **all databases**: counts by severity (click to filter), open problems over time (stacked by severity), status tabs, filters (database, severity, kind, text), paged table, **bulk confirm/reject** |
| `#/s/<name>` | header (kind, connection name, last run, health ring, Run now, Propose rules); tabs **Overview** (health per run, open problems per run, row counts of the 9 biggest tables with sparklines, freshness, health by schema), Problems, Rules, Relationships, Questions, Runs, Settings |
| `#/f/<id>` | the review bar on top; evidence as numbers, SQL (with Copy) and row IDs; **what it touches** (the table's links: tables it points to on the left, tables that point to it on the right); AI explanation marked as AI with its confidence; history as a timeline |

- **Row-count sparklines:** the shaded envelope is where each run was expected to land, from the table's usual change per run (mean ± 3 standard deviations, at least 1%: `BAND_SIGMAS`, `BAND_MIN_SHARE` in `charts.js`), so steady growth isn't flagged. It's a picture only; Lumida's volume checks decide what becomes a problem.
- **Checked by hand** in the browser pane against a throwaway store with the test lab and 7 nightly runs (spread over 7 days): every page, bulk confirm, the drawer, phone width (no sideways scrolling, the Menu works). Fixed along the way: a stray breadcrumb item; every growing table looked "outside the usual range" with a min/max band (replaced by the trend-aware envelope); health charts now start just below the lowest score.

## 5. Not yet
- **A full relationship map** of a database (today: the links of one table, on a problem's page). `lumida docs` still writes the Mermaid map.
- **Charts of a column's history** (null rate, distinct values) and column histograms: the data is stored, the endpoint isn't built yet.
- **Freshness against deadlines**: the panel shows when tables last changed (where the database reports it), not the deadlines people answered.
- **Notifications in the app**: alerts still go to Slack.
