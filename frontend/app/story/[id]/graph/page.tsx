import { redirect } from "next/navigation";

export default async function GraphPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/story/${id}/debate`);
}
