# Learning Hub · Admin Panel

Self-hosted backend + admin dashboard for the Learning Hub Android app.
Node.js/Express API, SQLite (via `better-sqlite3`, zero external DB server),
JWT-authenticated admin panel, API-key-authenticated public endpoints for
the app.

## 1. What's included

- **Admin panel** at `/admin` — dashboard, course/lesson management, user
  management, premium grants, notices, kill switch / maintenance mode,
  version gating, password management, audit log feed.
- **Public API** at `/api/public/*` — the four endpoints your Android app
  actually needs: config, courses, premium check, register + progress sync.
- **Admin API** at `/api/admin/*` — everything the panel calls, protected by
  JWT. You can also drive it directly (e.g. from a script) with the same
  bearer token.

## 2. What was deliberately left out

Your original brief mentioned per-device tracking pushed straight into a
Telegram bot, with no in-app disclosure. That's not in here. Instead:

- `config.analytics_enabled` is a real column, off by default, toggled from
  **Settings** in the panel. If you turn it on, wire your app's own opt-in
  notice around it — this backend just exposes the flag, it doesn't collect
  anything behind a user's back on its own.
- `/api/public/users/register` records only what the app explicitly sends
  (device_id, device_name, android_version, app_version) — nothing is
  fingerprinted or inferred server-side.

## 3. Local setup

```bash
npm install
cp .env.example .env
# edit .env: set ADMIN_PASSWORD, JWT_SECRET, PUBLIC_API_KEY to real values
npm start
```

Generate strong secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run that twice — once for `JWT_SECRET`, once for `PUBLIC_API_KEY`.

Open `http://localhost:3000/admin` and log in with `ADMIN_USERNAME` /
`ADMIN_PASSWORD` from `.env`. **Change the password from Settings
immediately after first login** — the bootstrap credential only exists to
get you in the door once.

## 4. Deploying

Any host that runs Node 18+ works — Render, Railway, Fly.io, a VPS, etc.
Steps are the same everywhere:

1. Push this folder to your host.
2. Set the environment variables from `.env.example` in the host's secrets
   manager (never commit `.env`).
3. Start command: `npm start`.
4. Point a domain at it and put it behind HTTPS (most PaaS hosts do this
   automatically; on a bare VPS, use Caddy or nginx + Let's Encrypt).
5. `DB_PATH` defaults to `./data/learning_hub.db` — make sure that path is
   on **persistent** storage, not an ephemeral filesystem, or your data
   disappears on redeploy.
6. Back up `data/learning_hub.db` on whatever schedule matters to you —
   it's a single file, `cp` is a valid backup strategy.

## 5. API reference (quick)

All `/api/admin/*` routes require `Authorization: Bearer <token>` from
`POST /api/admin/auth/login`. All `/api/public/*` routes require
`X-API-Key: <PUBLIC_API_KEY>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/auth/login` | Get a JWT |
| GET/POST/PUT/DELETE | `/api/admin/courses` | Course CRUD |
| PUT | `/api/admin/courses/reorder/batch` | Drag-and-drop reorder |
| GET/POST/PUT/DELETE | `/api/admin/folders` | Folder CRUD for Course → Folder → Video organization |
| GET/POST/PUT/DELETE | `/api/admin/lessons` | Lesson CRUD |
| POST | `/api/admin/lessons/batch` | Bulk-add lessons to a course |
| GET/PUT | `/api/admin/users` | List/update users |
| POST | `/api/admin/users/:id/block` \| `/unblock` | Block/unblock |
| GET | `/api/admin/users/export.csv` | CSV export |
| GET/POST/DELETE | `/api/admin/premium` | Premium grants |
| POST | `/api/admin/premium/bulk` | Bulk grant |
| GET/POST/PUT/DELETE | `/api/admin/notices` | Announcements |
| GET/PUT | `/api/admin/config` | App settings |
| POST | `/api/admin/config/kill` \| `/maintenance` \| `/alive` | App status |
| GET | `/api/admin/stats` \| `/stats/growth` \| `/stats/courses` \| `/stats/premium` | Analytics |
| GET | `/api/public/config` | Kill switch / version / notice for the app |
| GET | `/api/public/courses` | Course + lesson catalog |
| GET | `/api/public/premium/check/:deviceId` | Premium status |
| POST | `/api/public/users/register` | Register/touch a device |
| POST | `/api/public/users/progress` | Sync watch progress |

The admin panel supports a backward-compatible nested content model. A course may contain folders, and each folder may contain videos represented by the existing lesson records. Videos without a folder remain supported as unsorted course videos. The public course response continues to include the legacy flat `lessons` array and now also includes `folders`, where each folder contains its published videos.

## 6. Android (AndLua) integration

Replace the config/course-fetching logic in your app with calls to this
API. Below is a drop-in replacement for the relevant sections of your
existing script — same shape (`fetchRemoteConfig`, `applyRemoteConfig`,
device registration), pointed at your own server instead of a
Telegram-bot-managed gist.

**1. Point the app at your server:**

```lua
API_BASE   = "https://your-domain.example.com/api/public"
API_KEY    = "the PUBLIC_API_KEY value from your .env"
```

**2. Config fetch (kill switch / version / notice) — replace
`fetchRemoteConfig`:**

```lua
function fetchRemoteConfig(onDone)
  Thread(Runnable({run=function()
      local ok, parsed = pcall(function()
        local conn = URL(API_BASE .. "/config").openConnection()
        conn.setConnectTimeout(8000)
        conn.setReadTimeout(8000)
        conn.setRequestProperty("X-Api-Key", API_KEY)
        conn.setUseCaches(false)
        conn.connect()
        local reader = BufferedReader(InputStreamReader(conn.getInputStream()))
        local sb = {}
        local line = reader.readLine()
        while line ~= nil do sb[#sb+1] = line; line = reader.readLine() end
        reader.close(); conn.disconnect()
        local root = JSONObject(table.concat(sb, "\n"))
        return {
          app_status     = tostring(root.optString("app_status","ALIVE")),
          app_message    = tostring(root.optString("app_message","")),
          notice         = tostring(root.optString("notice","")),
          notice_enabled = root.optBoolean("notice_enabled", false),
        }
      end)
      activity.runOnUiThread(Runnable({run=function()
          if ok and parsed then REMOTE_CONFIG = parsed; pcall(applyRemoteConfig, parsed) end
          if onDone then onDone(ok and parsed ~= nil) end
        end}))
    end})).start()
end
```

**3. Course catalog — fetch instead of hardcoding `courses = {...}`:**

```lua
function fetchCourses(onDone)
  Thread(Runnable({run=function()
      local ok, list = pcall(function()
        local conn = URL(API_BASE .. "/courses").openConnection()
        conn.setRequestProperty("X-Api-Key", API_KEY)
        conn.connect()
        local reader = BufferedReader(InputStreamReader(conn.getInputStream()))
        local sb = {}
        local line = reader.readLine()
        while line ~= nil do sb[#sb+1] = line; line = reader.readLine() end
        reader.close(); conn.disconnect()
        local root = JSONObject(table.concat(sb, "\n"))
        local arr = root.getJSONArray("courses")
        local out = {}
        for i = 0, arr.length()-1 do
          local co = arr.getJSONObject(i)
          local course = { title=co.getString("title"), icon=co.optString("icon","📘"),
            level=co.optString("level","Beginner"), color=co.optString("color","#6C63FF"),
            desc=co.optString("desc",""), premium=co.optBoolean("premium",false), lessons={} }
          local ls = co.getJSONArray("lessons")
          for j = 0, ls.length()-1 do
            local lo = ls.getJSONObject(j)
            course.lessons[#course.lessons+1] = { title=lo.getString("title"),
              video=lo.optString("video",""), thumb=lo.optString("thumb",""), file=lo.optString("file","") }
          end
          out[#out+1] = course
        end
        return out
      end)
      activity.runOnUiThread(Runnable({run=function()
          if ok and list then courses = list end
          if onDone then onDone(ok) end
        end}))
    end})).start()
end
```

**4. Device registration — replace the silent `trackUniqueUser()` with an
explicit, disclosed registration call.** Show your users a one-line notice
("This app syncs your course progress to our server using a random device
ID — no personal data is collected") before or during first launch, then:

```lua
function registerDevice()
  Thread(Runnable({run=function()
      pcall(function()
        local body = "device_id=" .. getDeviceId()
          .. "&device_name=" .. tostring(android.os.Build.MODEL)
          .. "&android_version=" .. tostring(android.os.Build.VERSION.RELEASE)
          .. "&app_version=" .. APP_VER
        local conn = URL(API_BASE .. "/users/register").openConnection()
        conn.setRequestMethod("POST")
        conn.setDoOutput(true)
        conn.setRequestProperty("X-Api-Key", API_KEY)
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
        local os_ = conn.getOutputStream()
        os_.write(body:getBytes())
        os_.close()
        conn.getResponseCode()
        conn.disconnect()
      end)
    end})).start()
end
```

**5. Premium check** — same shape as your original `checkPremium`, just
pointed at the new endpoint and header:

```lua
function checkPremium(deviceId, onResult)
  Thread(Runnable({run=function()
      local isPrem = false
      pcall(function()
        local conn = URL(API_BASE .. "/premium/check/" .. deviceId).openConnection()
        conn.setRequestProperty("X-Api-Key", API_KEY)
        conn.connect()
        local reader = BufferedReader(InputStreamReader(conn.getInputStream()))
        local sb = {}
        local line = reader.readLine()
        while line ~= nil do sb[#sb+1] = line; line = reader.readLine() end
        reader.close(); conn.disconnect()
        local root = JSONObject(table.concat(sb, "\n"))
        isPrem = root.optBoolean("is_premium", false)
      end)
      activity.runOnUiThread(Runnable({run=function() if onResult then onResult(isPrem) end end}))
    end})).start()
end
```

**6. Cache + fallback**, matching your original design intent: keep the
last successful config/course fetch in `SharedPreferences`, use it if a
request fails or the device is offline, and re-fetch on app resume /
every ~10 minutes while foregrounded — same pattern as your existing
`remoteSyncHandler` loop, just calling `fetchRemoteConfig` /
`fetchCourses` against the new `API_BASE` instead of a gist URL.

## 7. Security notes

- Rotate `PUBLIC_API_KEY` from `.env` any time you suspect it leaked from a
  decompiled APK — it's a static string in the client either way, so treat
  it as a rate-limiting/abuse deterrent, not a secret that gates anything
  sensitive. It does not grant admin access.
- The admin JWT (`JWT_SECRET`) is what actually protects course/user/
  premium management — keep that one server-side only, never in the app.
- `helmet`, `express-rate-limit`, and parameterized SQL (via
  `better-sqlite3` prepared statements) are already wired in against XSS,
  brute force, and injection respectively.
