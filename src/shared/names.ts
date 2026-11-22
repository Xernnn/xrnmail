/** Characters that turn the text after them around or set it apart. U+202E shows "photo‮gpj.exe" as
 *  photoexe.jpg, so a file name loses them wherever it's saved or shown. */
const REORDERING = /[‪-‮⁦-⁩]/

/** Those, the marks that steer the text beside them (U+200E, U+200F, U+061C), and what draws
 *  nothing at all: zero-width spaces and joiners of words, soft hyphens, byte-order marks. */
const INVISIBLE = /[‪-‮⁦-⁩‎‏؜​⁠-⁤⁪-⁯﻿­᠎￹-￻]/g

export const plainName = (name: string): string => name.replace(INVISIBLE, '')

/** Whether a name a stranger wrote turns itself around, which no real name needs to. */
export const reorders = (name: string): boolean => REORDERING.test(name)
