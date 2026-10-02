import * as http from "node:http";
import { LotteryService } from "./service";
import { ApiError } from "./errors";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("VALIDATION", "请求体必须是合法 JSON");
  }
}

export function createServer(service: LotteryService): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" ? await readBody(req) : {};

      if (method === "POST" && parts.length === 1 && parts[0] === "events") {
        return send(res, 201, service.createEvent(body));
      }
      if (method === "GET" && parts.length === 2 && parts[0] === "events") {
        return send(res, 200, service.getEvent(Number(parts[1])));
      }
      if (method === "POST" && parts.length === 3 && parts[0] === "events" && parts[2] === "rosters") {
        return send(res, 201, service.importRoster(Number(parts[1]), body.entries));
      }
      if (method === "GET" && parts.length === 4 && parts[0] === "events" && parts[2] === "rosters") {
        return send(res, 200, service.getRoster(Number(parts[1]), Number(parts[3])));
      }
      if (method === "POST" && parts.length === 3 && parts[0] === "events" && parts[2] === "draws") {
        return send(res, 200, service.confirmDraw(Number(parts[1]), body));
      }
      if (method === "GET" && parts.length === 4 && parts[0] === "events" && parts[2] === "draws") {
        return send(res, 200, service.getBatchResult(Number(parts[3])));
      }
      if (method === "POST" && parts.length === 5 && parts[0] === "events" && parts[2] === "draws" && parts[4] === "abandon") {
        if (!body.personId) throw new ApiError("VALIDATION", "personId 必填");
        return send(res, 200, service.abandon(Number(parts[3]), body.personId));
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
      }
    }
  });
}
