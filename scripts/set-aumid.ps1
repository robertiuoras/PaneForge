# Stamps System.AppUserModel.ID onto a .lnk so Windows knows the shortcut and the
# running window are the same app. Without it, launching from a pinned shortcut shows
# TWO taskbar buttons: the pin (identified by exe path) and the window (identified by
# the id from app.setAppUserModelId in src/main/index.ts). They must match.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File set-aumid.ps1 -Lnk <path> -Id <aumid>
#
# Prints the value read back from the file so callers can verify the write landed.
param(
  [Parameter(Mandatory = $true)][string]$Lnk,
  [Parameter(Mandatory = $true)][string]$Id
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Lnk)) {
  Write-Error "No such shortcut: $Lnk"
  exit 1
}

# WScript.Shell cannot touch a shortcut's property store, so this drops to the same COM
# interfaces the shell itself uses (IShellLink + IPropertyStore).
if (-not ('PaneForge.Aumid' -as [type])) {
  Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;

namespace PaneForge {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  internal class ShellLink { }

  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IPersistFile {
    void GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName,
              [MarshalAs(UnmanagedType.Bool)] bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct PropertyKey {
    public Guid fmtid;
    public int pid;
    public PropertyKey(Guid f, int p) { fmtid = f; pid = p; }
  }

  [StructLayout(LayoutKind.Sequential)]
  internal class PropVariant {
    public ushort vt;
    public ushort r1, r2, r3;
    public IntPtr p, p2;
  }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IPropertyStore {
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PropertyKey pkey);
    void GetValue(ref PropertyKey key, [In, Out] PropVariant pv);
    void SetValue(ref PropertyKey key, PropVariant pv);
    void Commit();
  }

  public static class Aumid {
    // System.AppUserModel.ID
    static PropertyKey Key = new PropertyKey(
      new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

    const int STGM_READ = 0;
    const int STGM_READWRITE = 2;
    const ushort VT_LPWSTR = 31;

    [DllImport("ole32.dll", PreserveSig = false)]
    static extern void PropVariantClear([In, Out] PropVariant pvar);

    public static void Set(string lnk, string id) {
      object link = new ShellLink();
      ((IPersistFile)link).Load(lnk, STGM_READWRITE);
      var store = (IPropertyStore)link;
      // InitPropVariantFromString is an inline header helper, not a propsys export, so
      // build the VT_LPWSTR variant by hand. PropVariantClear frees the CoTaskMem copy.
      var pv = new PropVariant { vt = VT_LPWSTR, p = Marshal.StringToCoTaskMemUni(id) };
      try {
        store.SetValue(ref Key, pv);
        store.Commit();
      } finally {
        PropVariantClear(pv);
      }
      // null path = save back over the file we loaded
      ((IPersistFile)link).Save(null, true);
      Marshal.FinalReleaseComObject(link);
    }

    public static string Get(string lnk) {
      object link = new ShellLink();
      ((IPersistFile)link).Load(lnk, STGM_READ);
      var pv = new PropVariant();
      try {
        ((IPropertyStore)link).GetValue(ref Key, pv);
        return pv.vt == VT_LPWSTR ? Marshal.PtrToStringUni(pv.p) : null;
      } finally {
        PropVariantClear(pv);
        Marshal.FinalReleaseComObject(link);
      }
    }
  }
}
'@
}

$full = (Resolve-Path -LiteralPath $Lnk).Path
[PaneForge.Aumid]::Set($full, $Id)
$read = [PaneForge.Aumid]::Get($full)
if ($read -ne $Id) {
  Write-Error "AppUserModelID did not stick on $full (read back: '$read')"
  exit 1
}
Write-Output "$full -> $read"
