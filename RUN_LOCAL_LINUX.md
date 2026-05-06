# Run Wren UI on Linux (No Docker, No System Install)

This runs `wren-ui` on a Linux server without Docker and without installing Node globally.

## 1) Get the code

```bash
git clone https://github.com/Canner/WrenAI.git
cd WrenAI
```

If you already have the repo:

```bash
cd ~/WrenAI
git pull
```

## 2) Download portable Node 18 locally

```bash
cd ~/WrenAI
mkdir -p .local-node
cd .local-node
curl -fsSL https://nodejs.org/dist/v18.20.4/node-v18.20.4-linux-x64.tar.xz -o node18.tar.xz
tar -xf node18.tar.xz
export PATH="$PWD/node-v18.20.4-linux-x64/bin:$PATH"
node -v
npm -v
```

Expected Node version: `v18.20.4`

## 3) Install dependencies

```bash
cd ~/WrenAI/wren-ui
npm install --legacy-peer-deps
```

## 4) Configure environment

Set PostgreSQL config (required):

```bash
export DB_TYPE=pg
export PG_URL='postgresql://USERNAME:PASSWORD@HOST:PORT/postgres?sslmode=require'
export OTHER_SERVICE_USING_DOCKER=false
export TZ=UTC
```

Optional Supabase keys:

```bash
export SUPABASE_SERVICE_ROLE_KEY='YOUR_SERVICE_ROLE_KEY'
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='YOUR_PUBLISHABLE_KEY'
export NEXT_PUBLIC_SUPABASE_URL='https://YOUR_PROJECT_REF.supabase.co'
```

Notes:
- For IPv4-only servers, prefer Supabase **shared pooler** host with port `6543`.
- Direct host `db.<project-ref>.supabase.co:5432` may require IPv6.

## 5) Run migrations and start app

```bash
cd ~/WrenAI/wren-ui
npx knex migrate:latest
npx next dev -p 3000
```

Open:

`http://<server-ip>:3000`

## 6) Keep PATH persistent (optional)

If you want portable Node available in future shells:

```bash
echo 'export PATH="$HOME/WrenAI/.local-node/node-v18.20.4-linux-x64/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

## 7) Common errors

- `ERR_DLOPEN_FAILED` / `better-sqlite3` ABI mismatch:
  - You are on wrong Node version. Use Node 18.20.4 from Step 2.

- `no such table` errors:
  - Run migrations again:
  ```bash
  npx knex migrate:latest
  ```

- DB connection timeout/failure with Supabase:
  - Switch to shared pooler connection string (`port 6543`) and keep `sslmode=require`.
