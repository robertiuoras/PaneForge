// Hand-written declarations for the one export of this .mjs that `src/main/reviews.ts`
// imports; tsc does not read JSDoc out of an ESM file it is only told to allow.
export function cardNumber(list: ReadonlyArray<{ id: string }>, id: string): number
