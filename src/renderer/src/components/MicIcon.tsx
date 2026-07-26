// The mic used to be the 🎤 emoji, which every platform draws in its own colour and its
// own weight - a glossy stage mic sitting in a row of thin monochrome glyphs. This is a
// stroked capsule mic on the same 24-grid and the same currentColor as the other icons,
// so a pane header reads as one set.

export default function MicIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
    </svg>
  )
}
