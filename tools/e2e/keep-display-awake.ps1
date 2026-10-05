# Hold a display/system request only while the owning runner keeps stdin open.
# The native call and its restoration execute on the same managed thread.
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SmgE2eDisplayLease {
    [DllImport("kernel32.dll")]
    private static extern uint SetThreadExecutionState(uint flags);
    public static void Run() {
        uint previous = SetThreadExecutionState(0x80000003);
        Console.WriteLine("{\"applied\":" + (previous != 0 ? "true" : "false") + ",\"previous\":" + previous + "}");
        try { Console.ReadLine(); }
        finally {
            bool restored = previous == 0 || SetThreadExecutionState(previous) != 0;
            Console.WriteLine("{\"restored\":" + (restored ? "true" : "false") + "}");
        }
    }
}
'@
[SmgE2eDisplayLease]::Run()
