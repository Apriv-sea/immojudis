import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Production CSP upgrades HTTP requests. Exercise it over TLS on loopback,
// with a disposable certificate used only by the isolated Playwright context.
const directory = mkdtempSync(join(tmpdir(), "immojudis-e2e-tls-"));
const key = join(directory, "key.pem");
const cert = join(directory, "cert.pem");
const config = join(directory, "openssl.cnf");
writeFileSync(
  config,
  "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n" +
    "[dn]\nCN=127.0.0.1\n[extensions]\nsubjectAltName=IP:127.0.0.1\n",
);
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    key,
    "-out",
    cert,
    "-config",
    config,
  ],
  { stdio: "ignore" },
);

const next = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3101"],
  { stdio: "inherit" },
);
const server = https.createServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  (request, response) => {
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: 3101,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  },
);
server.listen(3100, "127.0.0.1");
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  next.kill("SIGTERM");
  process.exitCode = code;
}
next.on("exit", (code) => stop(code ?? 1));
next.on("error", () => stop(1));
server.on("error", () => stop(1));
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
