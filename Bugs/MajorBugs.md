Major Remaining Risks
Compressed-image matching is weak: cohort match rates ranged from 0% to 44.44% at the 0.68 threshold. This can create duplicate identities, missed attendance matches, or incorrect fraud classification.

Same-Area processing can be slow: Area serialization caused up to 42.8 seconds of lock waiting during a 20-request burst. More workers improve different-Area throughput but not contention within one Area.