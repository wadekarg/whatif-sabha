"use client";

type QA = { question: string; answer: string };

export default function PreRecordedQA({
  heading,
  subject,
  items,
}: {
  heading: string;
  subject: string;
  items: QA[];
}) {
  if (!items || items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[#e8dfd2] bg-white p-6 text-center text-[#a09282] italic">
        Pre-recorded Q&A coming soon — the live app lets you ask {subject} anything.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[#e8dfd2] bg-white p-6">
      <h3 className="font-serif text-lg mb-3 text-[#1c1410]">{heading}</h3>
      <ul className="space-y-2 text-sm text-[#2a1f14]">
        {items.map((q, i) => (
          <li key={i}>
            <p className="font-medium">{q.question}</p>
            <p className="text-[#5a4a38]">{q.answer}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
