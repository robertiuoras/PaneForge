// One entry so `desk-test.mjs` can reach the ranking rules as well as the list that uses
// them: a row's WORDS and its GROUP are two halves of the same judgement and a test that
// can only see one of them pins half of it.
export { deskGroups, deskRows } from '../src/shared/desk'
export { fleetRow, fleetState } from '../src/shared/fleet'
