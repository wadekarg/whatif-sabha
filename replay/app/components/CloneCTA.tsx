const REPO_URL = "https://github.com/wadekarg/What-If-Sabha";

export function CloneCTA() {
  return (
    <a href={REPO_URL}
       target="_blank"
       rel="noreferrer"
       className="inline-flex items-center gap-2 px-4 py-2 rounded-lg
                  bg-[color:var(--ink)] text-[color:var(--bg)] font-medium
                  hover:opacity-90 transition-opacity">
      <span>⭐ Clone on GitHub</span>
    </a>
  );
}
