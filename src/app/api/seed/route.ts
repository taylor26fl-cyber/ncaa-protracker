export const runtime = "nodejs";
export async function POST() {
  return new Response("Seed is stored in data/db.json. Edit that file to add games.", { status: 200 });
}
