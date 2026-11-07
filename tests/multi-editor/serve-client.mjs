// Serves a checkout's client with Vite and proxies /api to the mock.
// usage (cwd must be the checkout: Tailwind resolves its content globs from the working directory,
// and without that the page renders unstyled):
//   node serve-client.mjs <checkout> <port> <mock-port> <work-dir>
//
// Nothing is written into the checkout: Vite's cache and the stub env live in <work-dir>, and no
// config file of the checkout is read, so its dev proxy to the real Worker is never in play.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [root, port, mockPort, work] = process.argv.slice(2);
if (!root || !port || !mockPort || !work) {
  console.error('usage: node serve-client.mjs <checkout> <port> <mock-port> <work-dir>');
  process.exit(2);
}
if (path.resolve(process.cwd()) !== path.resolve(root)) {
  console.error(`cwd ${process.cwd()} is not the checkout ${root}`);
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const { createServer } = await import(`${root}/node_modules/vite/dist/node/index.js`);
const { default: react } = await import(`${root}/node_modules/@vitejs/plugin-react/dist/index.js`);

// The app refuses to start without these; the values are never used (the Auth0 module is stubbed).
const envDir = path.join(work, 'env');
fs.mkdirSync(envDir, { recursive: true });
fs.writeFileSync(
  path.join(envDir, '.env.development'),
  [
    'VITE_AUTH0_DOMAIN=stub.invalid',
    'VITE_AUTH0_CLIENT_ID=stub',
    // Cloudflare's published always-pass Turnstile test key.
    'VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA',
    '',
  ].join('\n'),
);

const server = await createServer({
  configFile: false,
  root,
  cacheDir: path.join(work, 'vite-cache'),
  envDir,
  mode: 'development',
  clearScreen: false,
  plugins: [react()],
  resolve: {
    alias: [{ find: '@auth0/auth0-react', replacement: path.join(here, 'lib/auth-stub.jsx') }],
  },
  server: {
    host: '127.0.0.1',
    port: Number(port),
    strictPort: true,
    fs: { allow: [root, here] },
    watch: null,
    hmr: false,
    proxy: { '/api': { target: `http://127.0.0.1:${mockPort}`, changeOrigin: true } },
  },
});
await server.listen();
console.log(`vite up on ${port} for ${root}`);
