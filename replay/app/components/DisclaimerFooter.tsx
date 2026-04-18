interface Props {
  text: string;
}

export function DisclaimerFooter({ text }: Props) {
  return (
    <footer className="border-t border-[#e5d7b5] bg-[#f7ecd6] py-2 px-4
                        text-[11px] text-[color:var(--ink-muted)] text-center">
      {text}
    </footer>
  );
}
