import { serveDir } from "jsr:@std/http@^1.0.25/file-server";

Deno.serve((req) => serveDir(req, { fsRoot: "dist" }));
