// The one rule for counting fraud flags in totals, cards and badges: a flag an admin decided was
// "not fraud" is no longer fraud. Open and confirmed flags still count. Every fraud count in
// SQL uses it (tests/unit/fraudCount.test.ts checks that), so clearing a flag clears it everywhere.
export const countsAsFraud = (alias: string) => `${alias}.resolution IS DISTINCT FROM 'not_fraud'`;
