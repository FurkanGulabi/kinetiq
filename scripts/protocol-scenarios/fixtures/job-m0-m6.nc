(Kinetiq protocol scenario: M0 and M6 pauses, then Hold / Resume on the long move)
G21 G90
G0 Z5
G0 X0 Y0
M3 S10000
G1 Z-1 F300
G1 X10 F600
M0 (check the first cut)
G1 Y10
G0 Z5
M5
T2 M6 (manual tool change)
M3 S12000
G1 Z-1 F300
G1 X0 F600
G1 Y0
G1 X40 F300 (long move: Hold / Resume happen here)
G0 Z5
M5
G0 X0 Y0
M30
