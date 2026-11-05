import type { CSSProperties } from 'react'
import { fileIconPrefs, iconName } from './fileIcons'
const PATHS: Record<string, string> = {
  file: 'M6 2.5h5.5L15 6v11.5H6zM11.5 2.5V6H15',
  folder: 'M2.5 5.5h5l1.5 2h8.5v9h-15z',
  chevron: 'M7 5l5 5-5 5',
  split: 'M3 4h14v12H3zM10 4v12',
  extensions: 'M3 3h6v6H3zM3 11h6v6H3zM11 11h6v6h-6zM12.5 3.5l4 4-4 4-4-4z',
  read: 'M2.5 10s3-5.5 7.5-5.5 7.5 5.5 7.5 5.5-3 5.5-7.5 5.5S2.5 10 2.5 10zM10 12.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z',
  edit: 'M12.5 3.5l4 4L7 17H3v-4zM10.5 5.5l4 4',
  list: 'M4 5.5h12M4 10h12M4 14.5h12',
  search: 'M9 15a6 6 0 100-12 6 6 0 000 12zM13.5 13.5L17 17',
  terminal: 'M3 4.5h14v11H3zM6 8l2.5 2L6 12M10.5 12.5H14',
  send: 'M10 16V4M5 9l5-5 5 5',
  stop: 'M5.5 5.5h9v9h-9z',
  plus: 'M10 4v12M4 10h12',
  gear: 'M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4',
  branch: 'M6 3.5v13M6 7c0 3 8 2 8-2M14 5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM6 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  history: 'M3.5 10a6.5 6.5 0 106.5-6.5A6.5 6.5 0 004 7.5M4 3.5v4h4M10 6.5V10l2.5 1.5',
  close: 'M5 5l10 10M15 5L5 15',
  check: 'M4 10.5l4 4 8-9',
  undo: 'M7 5L3.5 8.5 7 12M4 8.5h8a4 4 0 010 8H9',
  warn: 'M10 3l8 14H2zM10 8.5v4M10 14.8v.2',
  chip: 'M5.5 5.5h9v9h-9zM8 2.5v3M12 2.5v3M8 14.5v3M12 14.5v3M2.5 8h3M2.5 12h3M14.5 8h3M14.5 12h3',
  cloud: 'M6 15.5a3.5 3.5 0 01-.5-7 5 5 0 019.6.9 3.1 3.1 0 01-.6 6.1z',
  copy: 'M7.5 7.5h9v9h-9zM12.5 7.5v-4h-9v9h4',
  newfile: 'M5 2.5h6l4 4v11H5zM11 2.5v4h4M10 9.5v5M7.5 12h5',
  newfolder: 'M2.5 5.5h5l1.5 2h8.5v9h-15zM10 9.5v5M7.5 12h5',
  play: 'M6 4l10 6-10 6z',
  sparkle: 'M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6zM15.5 14l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z',
  bug: 'M10 3a6 6 0 016 6v2a6 6 0 01-12 0V9a6 6 0 016-6zM10 7v5M10 14.5v.2',
  trash: 'M4 5.5h12M8 5.5v-2h4v2M5.5 5.5l.7 11h7.6l.7-11'
}

export function Icon({ name, size = 15 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}

/** The Pitoo logo: a small orange cat. It stays still, so nothing moves while you code. */
export function Logo() {
  return (
    <span className="logo">
      <svg viewBox="0 0 34 30" aria-hidden>
        <path d="M4 11L4.500 3c.1-1.200 1.400-1.700 2.300-.8L13 7zM30 11l-.5-8c-.1-1.200-1.400-1.700-2.300-.8L21 7z" fill="#f6a04d" />
        <ellipse cx="17" cy="16" rx="15" ry="13" fill="#f6a04d" />
        <circle cx="10.500" cy="15" r="3.300" fill="#2fc06c" /><circle cx="23.500" cy="15" r="3.300" fill="#2fc06c" />
        <circle cx="10.900" cy="15" r="2" fill="#201a16" /><circle cx="23.900" cy="15" r="2" fill="#201a16" />
        <circle cx="11.700" cy="14" r=".7" fill="#fff" /><circle cx="24.700" cy="14" r=".7" fill="#fff" />
        <path d="M15.500 20q1.500 1.500 3 0" stroke="#7a4220" strokeWidth="1" fill="none" strokeLinecap="round" />
        <ellipse cx="6" cy="20" rx="2.500" ry="1.400" fill="#ff8f9a" opacity=".7" /><ellipse cx="28" cy="20" rx="2.500" ry="1.400" fill="#ff8f9a" opacity=".7" />
      </svg>
    </span>
  )
}

/** A file or folder icon from Material Icon Theme, or a plain outline if the setting is off. */
export function FileIcon({ name, isDir = false, open = false, size = 15 }: { name: string; isDir?: boolean; open?: boolean; size?: number }) {
  const { on, light } = fileIconPrefs()
  if (!on) return <Icon name={isDir ? 'folder' : 'file'} size={Math.max(12, size - 2)} />
  return <img className="file-icon" src={`./file-icons/${iconName(name, isDir, open, light)}.svg`} width={size} height={size} alt="" draggable={false} />
}
