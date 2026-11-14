// Where the app finds its data. Relative addresses are resolved against this
// file: locally, server.py serves the app, then the top of the repository
// (bundles/, build/). A deployment replaces it to serve the data from
// elsewhere (see deploy/deploy.sh). Data on another origin needs CORS
// headers allowing the app.
// MDraft: the bundle data is served through the app's own origin/protocol so the
// WebView never talks to a third-party host.
const DATA_BASE = '/texpresso-data/';
const data = path => DATA_BASE + path;

const config = {
    // The bundles of TeX Live files this app can use, by name (see
    // bundles/bundles.toml). A project uses one; new projects the default.
    //   files   address of the files
    //   list    their names, one per line; deployed, '@folder' lines say
    //           in which folder of files/ the names after them are, and
    //           its first line how they are stored (see ocaml/src/prefetch.ml)
    //   deps    what to download together (make-prefetch.py)
    //   format  the format, made from the bundle for this build of the engine
    //   luatexFormat  the format of the LuaTeX engine, if the bundle has one:
    //           its projects can then be compiled with LuaLaTeX (the bundle
    //           has the Lua files, see engine/doc/RETCON.md)
    //   luatexCache  the caches of luaotfload made with that format, if they
    //           are not in the bundle: an ustar archive of luatex-cache/
    //           (deploy/luatex-format.sh)
    bundles: {
        'tt2026': {
            title: 'TeX Live 2026',
            files: data('files/'),
            list: data('tt2026/v3.lst'),
            deps: data('tt2026/v3-36c268c2b4d8b963.deps'),
            format: data('tt2026/v3-3f7cdba0ab1f1379.fmt'),
            luatexFormat: data('tt2026/v3-d094cf86958dd603.luatex.fmt'),
            luatexCache: data('tt2026/v3-33a89a90d6d9c9e4.luatex-cache.tar'),
        },
    },
    defaultBundle: 'tt2026',
    // Shared projects: where peers find each other (a WebSocket service, see
    // cloudflare/worker.js), and how they connect through NATs
    signaling: 'signal/',
    iceServers: [],
    // Where the feedback form sends its messages (POST, see
    // cloudflare/feedback.js; locally server.py keeps them in
    // build/feedback.jsonl), null for no form; and the version sent with them
    feedback: null,
    // Where crash reports go (POST, see cloudflare/crashes.js and
    // ocaml/src/crashes.ml; locally build/crashes.jsonl), null for none
    crashes: null,
    // The mailbox of shared projects: their changes kept, encrypted, for
    // those who come back (deploy/MAILBOX.md; locally server.py keeps them
    // in build/mailbox.db), null for none: new rooms are made there. And
    // mailboxes that make no new room, but whose rooms are still read and
    // written until they expire (after a move to another server)
    mailbox: null,
    mailboxDraining: [],
    // Syncing projects with Dropbox: the app key of a Dropbox app (OAuth with
    // PKCE: no secret), whose redirect URIs list this folder's dropbox.html;
    // null for none. { appKey } (the endpoints can be changed, for tests:
    // api, content, notify, authorize)
    dropbox: null,
    // Committing projects to GitHub and pulling them from it (a personal
    // access token of the user, kept in the browser: see ocaml/src/github.ml): the
    // address of its API; null for none
    github: null,
    // The origin of the app's former address, after a move to this one: the
    // page left there brings the projects of its browser (import.html);
    // null for none
    movedFrom: null,
    version: 'release-0-133-g454f1bc',
};

const resolve = url => new URL(url, import.meta.url).href;
// name → { name, title, files, list, deps, format, luatexFormat, luatexCache },
// addresses resolved
export const BUNDLES = new Map(Object.entries(config.bundles).map(([name, b]) => [name, {
    name, title: b.title || name,
    files: resolve(b.files.replace(/\/*$/, '/')), list: resolve(b.list),
    deps: b.deps ? resolve(b.deps) : null, format: resolve(b.format),
    luatexFormat: b.luatexFormat ? resolve(b.luatexFormat) : null,
    luatexCache: b.luatexFormat && b.luatexCache ? resolve(b.luatexCache) : null,
}]));
export const DEFAULT_BUNDLE = config.defaultBundle;
// The engines a project can be compiled with (XeLaTeX unless it says so):
// name → title; LuaLaTeX with the bundles that have its format
export const ENGINES = new Map([['xetex', 'XeLaTeX'], ['luatex', 'LuaLaTeX']]);
// MDraft sets this before importing the module. A new project inherits it;
// existing projects are switched in index.html before the app opens them.
const requestedEngine = globalThis.__TEXPRESSO_ENGINE__;
export const DEFAULT_ENGINE =
    requestedEngine === 'luatex' || requestedEngine === 'xetex' ? requestedEngine : 'xetex';
export const SIGNALING_URL = resolve(config.signaling.replace(/\/*$/, '/')).replace(/^http/, 'ws');
export const ICE_SERVERS = config.iceServers;
export const FEEDBACK_URL = config.feedback ? resolve(config.feedback) : null;
export const CRASH_URL = config.crashes ? resolve(config.crashes) : null;
// The mailboxes, the one of new rooms first ([] for none)
export const MAILBOX_URLS = config.mailbox ? [config.mailbox, ...config.mailboxDraining ?? []]
    .map(url => resolve(url.replace(/\/*$/, '/'))) : [];
export const DROPBOX = config.dropbox;
export const MOVED_FROM = config.movedFrom;
export const GITHUB = config.github;
export const VERSION = config.version;
