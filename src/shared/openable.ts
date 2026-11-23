/** The kinds of file an attachment may be opened as, each by the names it can have. */
export type FileFamily = 'pdf' | 'text' | 'rtf' | 'office' | 'image' | 'media' | 'archive' | 'calendar' | 'contact'

const FAMILIES: Record<FileFamily, string[]> = {
  pdf: ['pdf'],
  text: ['txt', 'md', 'csv', 'tsv', 'log'],
  rtf: ['rtf'],
  office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic'],
  media: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'mov', 'mkv', 'webm'],
  archive: ['zip', 'tar', 'gz', '7z', 'rar'],
  calendar: ['ics'],
  contact: ['vcf']
}

const BY_EXTENSION = new Map(Object.entries(FAMILIES).flatMap(([family, extensions]) => extensions.map((e) => [e, family as FileFamily])))

/** What a file's name says it is, if that's a kind that may be opened at all. */
export function familyOfName(name: string): FileFamily | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  return (extension && BY_EXTENSION.get(extension)) || null
}

/** Whether an attachment's name allows opening it straight away, which hands a stranger's file to
 *  whatever handles its type. A list of what's fine, because a list of what isn't would miss
 *  something, and everything else can still be saved. The name is only the first test: the main
 *  process opens a file only once its bytes say the same (opening.ts). */
export const canOpenDirectly = (name: string): boolean => familyOfName(name) !== null
