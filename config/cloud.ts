import type { CloudConfig as TsCloudConfig } from '@stacksjs/ts-cloud'
import type { CloudConfig } from '@stacksjs/ts-cloud-types'

/**
 * ts-cloud deployment configuration.
 *
 * This has to be the named `tsCloud` export: `buddy deploy` imports
 * `config/cloud.ts` and reads `tsCloud.mode`, `tsCloud.project` and the rest
 * off that binding. All of this previously sat on the file's default export
 * instead, where the deploy never looked, so the domain and the DNS provider
 * had no effect on an actual deployment.
 */
/**
 * The production SQLite file, deliberately outside every release directory.
 *
 * A release is disposable: ts-cloud unpacks each deploy into
 * `releases/<sha>/` and prunes old ones. The database defaults to the
 * relative `database/stacks.sqlite`, which put it INSIDE that directory —
 * so every account, trail and activity written by the running site was
 * discarded the moment the next release cut over, and replaced by whatever
 * happened to be in the developer's local checkout.
 *
 * The two sites also ran as separate deployments with separate release dirs,
 * so `main` and `api` were reading and writing two different files: an account
 * created through the API was invisible to anything the page server did.
 *
 * One absolute path outside both fixes both problems. `DB_DATABASE_PATH` is
 * what `config/database.ts` reads for the sqlite connection.
 */
const SHARED_DATABASE = '/var/www/wildloop-shared/database/stacks.sqlite'

/**
 * Link `.env.keys` into a release from the site's persistent `shared/` dir.
 *
 * `.env.production` is committed with its sensitive values encrypted, so it
 * ships with every release. The private half that decrypts them lives in
 * `.env.keys`, which is gitignored — and ts-cloud builds the release tarball
 * from git-tracked files, so it can never ride along. Without this the box
 * runs with `APP_KEY="encrypted:…"` as a literal string.
 *
 * `scripts/push-env-keys.ts` puts the file in `shared/` (see `bun run deploy`),
 * which survives releases exactly as `shared/.env` does. This links it in.
 * Non-fatal: a first deploy runs before the file exists, and failing the whole
 * release for a missing symlink would be worse than starting without it.
 */
const LINK_ENV_KEYS = 'ln -sf ../../shared/.env.keys .env.keys 2>/dev/null || true'

/**
 * Install dependencies with the same stable Bun line that writes and verifies
 * the committed lockfile locally. A project-local 1.4 canary previously tried
 * to rewrite Bun 1.3.14's lockfile and correctly failed under
 * `--frozen-lockfile`. The shared box already provides 1.3.14 at this path, so
 * pinning it makes the install reproducible without mutating the owner runtime.
 */
const INSTALL_BUN = '/usr/local/bin/bun'

const INSTALL_DEPS = `${INSTALL_BUN} install --frozen-lockfile`

// Production intentionally excludes the vendored framework tree. Point Bun at
// Stacks' published canonical preloader so package-only deployments retain the
// same auto-import behavior as a full development checkout.
const PREPARE_PRODUCTION_BUNFIG =
  "sed -i 's#./storage/framework/defaults/resources/plugins/preloader.ts#@stacksjs/defaults/resources/plugins/preloader#' bunfig.toml"

/**
 * Files that belong to a developer checkout or to mutable host state, never to
 * an immutable production release. In particular, shipping database/*.sqlite
 * copied a 191 MB local catalog into every site tarball even though all three
 * services use SHARED_DATABASE on the server. Keeping this list shared also
 * guarantees main, api, and ingest are built from the same source boundary.
 */
const SOURCE_RELEASE_EXCLUDES = [
  '.claude',
  '.codex',
  '.git',
  '.env',
  '.env.keys',
  'coverage',
  'database/*.sqlite',
  'database/*.sqlite-*',
  'dist',
  'node_modules',
  'pantry',
  'storage/cloud',
  'storage/framework',
  'storage/logs',
  'storage/screenshots',
]

export const tsCloud: TsCloudConfig = {
  project: {
    name: 'WildLoop',
    slug: 'wildloop',
    region: 'us-east-1',
  },

  /**
   * Compute lives on Hetzner, not AWS.
   *
   * `attachTo` means this project provisions nothing of its own: it deploys
   * onto the `stacks-<environment>-app` server the `stacks` project owns,
   * shipping only WildLoop's sites plus its own additive rpx fragment and DNS.
   * The box lifecycle, firewall and other tenants stay untouched. Reading the
   * shared server needs HCLOUD_TOKEN in the environment.
   */
  cloud: {
    provider: 'hetzner',
    attachTo: 'stacks',
  },

  mode: 'server',

  environments: {
    production: {
      type: 'production',
      domain: 'wildloop.org',
    },
  },

  sites: {
    // WildLoop renders stx views and proxies /api from a Bun server, so it
    // runs under `buddy serve` behind rpx rather than shipping as a static
    // bundle. 3049 is this project's slot on the shared box (localhost only;
    // rpx fronts it by Host). 3000-3048 are already claimed by the box owner
    // and the other tenants.
    //
    // `start` must name a module bun can execute: ts-cloud always builds
    // `ExecStart=/usr/local/bin/bun <start>`. Pointing it at the root `buddy`
    // script made bun parse a shell script as JavaScript, and the service
    // crash-looped on `ROOT_DIR=$(...)` before it ever bound a port.
    //
    // So the server is buddy's own `serve-entry` — the dedicated production
    // entry it publishes for exactly this, which calls `startProductionServer`
    // with no command parser attached. Bundled below rather than run out of
    // node_modules so the release starts from one file it owns.
    main: {
      root: '.',
      exclude: SOURCE_RELEASE_EXCLUDES,
      deploy: 'server',
      path: '/',
      domain: 'wildloop.org',
      start: 'bun storage/framework/runtime/production/serve.js',
      port: 3049,
      // The release ships without dependencies, so nothing resolves until
      // install runs here.
      //
      // This site migrates, and it is the only one that does. `migrate` is
      // also the marker the deploy uses to decide which site owns the
      // database — the owner's shared path is what the siblings link at, and
      // the owner is where the automatic `db:backup --before-migrations` is
      // spliced in — so a second site running it would make ownership
      // ambiguous rather than migrate twice.
      //
      // `--no-generate` is doing real work here. Plain `buddy migrate`
      // regenerates SQL from the models before applying it, and the model
      // snapshot is gitignored, so the box has none: generation there would
      // diff against nothing and write a fresh migration set over a database
      // that already has those tables. This applies `database/migrations` and
      // derives nothing.
      //
      // Stacks ≥0.73.2 injects this automatically for every app; declared
      // explicitly because this app is on 0.73.1, and because an app that
      // names its own migrate step is deliberately left alone by that
      // injection.
      //
      // The scheduler is the same story. `app/Scheduler.ts` declares hourly
      // ranks, daily decay and counter repair, and the deploy attaches a
      // scheduler to the database owner when it finds them. A site of our own
      // running `schedule:run` would be a SECOND scheduler — every job twice,
      // two decay sweeps over the same territories.
      //
      // What the note here used to worry about — schema work riding an
      // application cutover unreviewed and unbacked — is handled now: the dump
      // is automatic, and `--no-generate` means the box applies migrations that
      // were reviewed and merged rather than deriving new SQL from whatever
      // models the release happens to hold.
      //
      // The requirement that remains is on the migrations themselves. During a
      // zero-downtime cutover the old release is still serving while they run,
      // so a migration has to be one the previous code survives: additive
      // columns and new indexes are, a rename or a NOT NULL without a default
      // is not. `migrate` is the
      // marker the deploy uses to decide which site owns the database: the
      // owner's shared path is the one the others link at, and the owner is
      // where the pre-migration dump is spliced in. A second site running it
      // would not migrate twice — it would make ownership ambiguous.
      //
      // Migrations used to be excluded here on the grounds that schema work
      // should be backed up and reviewed rather than riding an application
      // cutover. The backup half of that is now the deploy's job: it inserts
      // `db:backup --before-migrations` ahead of this step automatically, into
      // a project-level directory outside every release tree, so a bad
      // migration has something to go back to. The review half stays a human
      // one — what this changes is only that a reviewed, merged migration
      // reaches production with the code that needs it, instead of the code
      // arriving first and reading columns that do not exist yet.
      //
      // Which puts a requirement on the migrations themselves: during a
      // zero-downtime cutover the OLD release is still serving while this
      // runs, so a migration must be one the previous code survives. Additive
      // columns and new indexes are; a rename or a NOT NULL without a default
      // is not, and wants the two-release path instead.
      preStart: [
        LINK_ENV_KEYS,
        INSTALL_DEPS,
        PREPARE_PRODUCTION_BUNFIG,
        'mkdir -p storage/framework/runtime/production',
        'bun build --production --target=bun --packages=external node_modules/@stacksjs/buddy/dist/serve-entry.js --outfile storage/framework/runtime/production/serve.js',
        // The database lives OUTSIDE the release, so create its directory
        // before migrate runs — on a fresh box nothing else would.
        'mkdir -p /var/www/wildloop-shared/database',
        './buddy migrate --no-generate',
        // This is an active test deployment with no real users. Run only the
        // idempotent account seeders here; the remaining application seeders
        // generate the large demo trail/activity corpus and do not belong in
        // every production release.
        './buddy seed --skip-models --only-seeders UserSeeder,AdminSeeder --verbose',
      ],
      // Pin the proxy target. `buddy serve` otherwise falls back to
      // 127.0.0.1:3008, which on this SHARED box is the `stacks` project's own
      // API - every /api/trails, /api/activities and /api/territories call
      // would silently answer from another tenant.
      env: {
        APP_ENV: 'production',
        NODE_ENV: 'production',
        API_URL: 'http://127.0.0.1:3050',
        // See the note on the api site below — both processes must open the
        // SAME file or they disagree about who exists.
        DB_DATABASE_PATH: SHARED_DATABASE,
      },
    },

    // The API behind `buddy serve`'s same-origin proxy. Without it nothing
    // serves routes/, so the app would fall back to seed data in the browser.
    //
    // Deliberately no `domain`: rpx skips domain-less sites, so this stays
    // loopback-only. HOST pins the bind to 127.0.0.1 because the box is
    // shared and a 0.0.0.0 bind would expose this API to every neighbour.
    api: {
      root: '.',
      exclude: SOURCE_RELEASE_EXCLUDES,
      deploy: 'server',
      start: 'bun storage/framework/runtime/production/api.js',
      port: 3050,
      preStart: [
        LINK_ENV_KEYS,
        INSTALL_DEPS,
        PREPARE_PRODUCTION_BUNFIG,
        'mkdir -p storage/framework/runtime/production',
        'bun build --production --target=bun --packages=external node_modules/@stacksjs/actions/dist/serve/api.js --outfile storage/framework/runtime/production/api.js',
        'mkdir -p /var/www/wildloop-shared/database',
      ],
      env: {
        HOST: '127.0.0.1',
        APP_ENV: 'production',
        NODE_ENV: 'production',
        DB_DATABASE_PATH: SHARED_DATABASE,
      },
    },

    // The trail ingest worker.
    //
    // Building the US trail catalog is a multi-day job — ~1,400 Overpass tiles
    // at two requests a minute, plus 466 Forest Service and Park Service
    // shards — and it has to keep running between deploys and re-sync itself
    // afterwards. Neither request-driven service above would ever run it, so
    // it gets a systemd unit of its own.
    //
    // Loopback-only like `api`, for the same reason: no `domain` keeps rpx
    // from publishing it, and HOST pins the bind so the neighbours on this
    // shared box cannot reach it. Port 3051 is this project's third slot.
    //
    // The port exists because a `start` site needs one, but it is not wasted:
    // it answers `/` with the live shard counts and per-source trail totals,
    // which is the only practical way to check on a job this long.
    ingest: {
      root: '.',
      exclude: SOURCE_RELEASE_EXCLUDES,
      deploy: 'server',
      start: 'bun storage/framework/runtime/production/ingest.js',
      port: 3051,
      /*
       * Stop the old worker before starting the new one.
       *
       * The overlap cutover is right for the two sites above, where two
       * instances briefly sharing a port is exactly the point. It is wrong
       * here twice over. This worker claims shards from the database, so two
       * of them running at once is not a smoother deploy, it is the same tile
       * fetched twice against an Overpass endpoint already rationed to two
       * requests a minute. And the status port makes it look like a server to
       * the cutover: the new instance cannot bind 3051 while the old one is
       * draining, so it crash-looped on EADDRINUSE until systemd gave up —
       * which is how a deploy left this worker stopped entirely.
       */
      zeroDowntime: false,
      /*
       * Let it finish the shard it is holding.
       *
       * On SIGTERM this worker logs `finishing current shard` and drains,
       * because a shard abandoned mid-write has to be redone from the start.
       * systemd's default gives it 90 seconds and then SIGKILLs it, which it
       * did — killing the very thing the drain exists to protect. A shard is
       * minutes of Overpass-rationed work, so it gets minutes.
       */
      stopTimeout: '10min',
      preStart: [
        LINK_ENV_KEYS,
        INSTALL_DEPS,
        PREPARE_PRODUCTION_BUNFIG,
        'mkdir -p storage/framework/runtime/production',
        'bun build --production --target=bun --packages=external app/TrailIngestWorker.ts --outfile storage/framework/runtime/production/ingest.js',
        'mkdir -p /var/www/wildloop-shared/database',
      ],
      env: {
        HOST: '127.0.0.1',
        PORT: '3051',
        APP_ENV: 'production',
        NODE_ENV: 'production',
        // Where `/api/**` goes, same target `main` uses.
        //
        // This worker has no domain and serves only its own status page, so
        // nothing proxies through it today. The deploy preflight refuses
        // without it anyway, and it is right to: the moment this site is
        // published, every `/api/**` request through it answers 502, and that
        // is a failure you would find in production rather than here.
        PORT_API: '3050',
        // The same file the site and the API open. An ingest writing to its
        // own copy would build a catalog nobody could read.
        DB_DATABASE_PATH: SHARED_DATABASE,
      },
    },

    // www resolves to the same box, so it needs a vhost of its own or it falls
    // through to rpx's default and 404s. Redirecting keeps one canonical host.
    www: {
      domain: 'www.wildloop.org',
      redirect: { to: 'https://wildloop.org', status: 301 },
    },
  },

  infrastructure: {
    // This project attaches to an existing compute owner, but it still declares
    // its runtime/proxy contract so the deploy command takes the compute path
    // and the shared gateway renders WildLoop routes with rpx.
    //
    // Deliberately NO `proxy.version`. The gateway is the box's, not this
    // tenant's: every deploy reinstalls and recompiles it, so a version pinned
    // here is imposed on all eight tenants sharing the server. This pin held
    // rpx at 0.11.45 and silently rolled the box back from 0.11.52 twice in one
    // evening, re-breaking a clean-URL redirect fix that shipped in 0.11.53.
    // Unset means the owner's `latest`, which is the only version this project
    // has any business asking for.
    compute: {
      runtime: 'bun',
      webServer: 'rpx',
      proxy: {
        engine: 'rpx',
      },
    },
    dns: {
      /*
       * The zone lives on Cloudflare; the domain is registered at Porkbun.
       *
       * Cloudflare is not a preference here, it is a feature: it adds
       * `cf-iplatitude` / `cf-ipcity` to every proxied request, and
       * `app/Helpers/visitorCountry.ts` reads them so the catalog opens on
       * "Popular trails near <your city>" instead of on six hundred thousand
       * trails sorted by length. Without an edge in front, /api/geo/here
       * answers `located: false` and the page falls back to the whole catalog.
       *
       * `registrar` is what makes the move happen on deploy rather than by
       * hand at two dashboards: ts-cloud creates the zone, copies Porkbun's
       * records across, verifies record for record that they arrived, and only
       * then repoints the nameservers. It will not delegate into a zone it
       * could not verify — see packages/ts-cloud/src/dns/delegation.ts.
       */
      provider: 'cloudflare',
      domain: 'wildloop.org',

      registrar: {
        provider: 'porkbun',

        /*
         * Only the web hosts go through the proxy.
         *
         * `mail.wildloop.org` is deliberately absent and must stay that way.
         * Cloudflare does not proxy SMTP, and the proxy would replace the
         * origin address that this domain's own SPF record authorises — so a
         * proxied mail host degrades delivery some hours later with nothing
         * visibly broken to explain it. This domain runs its own mail.
         */
        proxied: [
          'wildloop.org',
          'www.wildloop.org',
          'dashboard.wildloop.org',
          'www.dashboard.wildloop.org',
        ],
      },

      /*
       * Settings the deploy keeps true, rather than a state of the dashboard
       * that nobody can reconstruct six months from now.
       *
       * `strict` is the only correct mode for this origin: the server holds a
       * real certificate, so the edge should both encrypt to it and verify it.
       * Cloudflare hands a new zone `full`, which encrypts without checking who
       * it is talking to; `flexible`, one click away in the same dropdown,
       * sends plaintext to an origin that redirects to HTTPS and produces an
       * infinite redirect loop — the usual way a Cloudflare migration appears
       * to take a site down.
       *
       * These are reconciled on every deploy, not once at delegation, because
       * this is exactly the kind of setting somebody changes by hand while
       * debugging something else and never changes back.
       */
      zone: {
        ssl: 'strict',
        alwaysUseHttps: true,
        minTlsVersion: '1.2',

        /*
         * Send the visitor's city and coordinates to the origin.
         *
         * This is the setting the Cloudflare migration was actually for.
         * `CF-IPCountry` is the only geo header a zone sends by default, so
         * `app/Helpers/visitorCountry.ts` — which reads `cf-ipcity` and
         * `cf-iplatitude` — got nothing, `/api/geo/here` answered
         * `located: false`, and the catalog fell back to the whole six hundred
         * thousand trails instead of the ones near you. Nothing about that is
         * visible at the edge: the request arrives correctly proxied, simply
         * without the headers the application was written against.
         */
        visitorLocationHeaders: true,
      },
    },
  },
}

// Stacks cloud configuration (for existing Stacks cloud features)
const config: CloudConfig = {}

export default config
