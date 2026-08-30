import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { documents } from "@/db/schema";

// documents.id is a database-generated UUID, not the human-readable slug
// (e.g. "is-14756-2017") used in /standards/[id] page URLs — those two id
// schemes are unrelated. This endpoint's contract is the raw UUID.
const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid standard id — expected a UUID" }, { status: 400 });
  }
  const { id } = parsed.data;

  try {
    const db = getDb();
    const doc = await db.query.documents.findFirst({
      where: eq(documents.id, id),
      with: { chunks: { orderBy: (c, { asc }) => [asc(c.createdAt)] } },
    });

    if (!doc) {
      return NextResponse.json({ error: "Standard not found" }, { status: 404 });
    }

    return NextResponse.json(doc);
  } catch (err) {
    console.error(`[api/standards/${id}] query failed:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to fetch standard" }, { status: 500 });
  }
}
