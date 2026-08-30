// @vitest-environment node
import { describe, test, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const findFirst = vi.fn();
vi.mock("@/db", () => ({
  getDb: () => ({ query: { documents: { findFirst } } }),
}));

const { GET } = await import("./route");

function req(id: string) {
  return {
    request: new NextRequest(new Request(`http://localhost/api/v1/standards/${id}`)),
    params: Promise.resolve({ id }),
  };
}

describe("GET /api/v1/standards/[id]", () => {
  test("rejects a non-UUID id with 400 instead of crashing", async () => {
    // documents.id is a UUID; "is-14756-2017" is the unrelated page-URL slug.
    // Postgres previously turned this mismatch into an unhandled 500.
    const { request, params } = req("is-14756-2017");
    const res = await GET(request, { params });
    expect(res.status).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
  });

  test("returns 404 for a well-formed UUID that has no matching document", async () => {
    findFirst.mockResolvedValueOnce(undefined);
    const { request, params } = req("00000000-0000-0000-0000-000000000000");
    const res = await GET(request, { params });
    expect(res.status).toBe(404);
  });

  test("returns the document for a UUID that matches", async () => {
    findFirst.mockResolvedValueOnce({ id: "75db37f2-a948-4347-8316-03f85f3e90a8", standardNumber: "IS 14756:2017", chunks: [] });
    const { request, params } = req("75db37f2-a948-4347-8316-03f85f3e90a8");
    const res = await GET(request, { params });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.standardNumber).toBe("IS 14756:2017");
  });

  test("returns 500, not a leaked stack trace, when the query itself fails", async () => {
    findFirst.mockRejectedValueOnce(new Error("connection reset"));
    const { request, params } = req("75db37f2-a948-4347-8316-03f85f3e90a8");
    const res = await GET(request, { params });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Failed to fetch standard" });
  });
});
