/** Characters that turn the text after them around or set it apart. U+202E shows "photo‮gpj.exe" as
 *  photoexe.jpg, so a file name loses them wherever it's saved or shown. */
const REORDERING = /[‪-‮⁦-⁩]/g

export const plainName = (name: string): string => name.replace(REORDERING, '')
