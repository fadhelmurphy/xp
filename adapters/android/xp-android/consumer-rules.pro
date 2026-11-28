# Registry komponen terkompilasi (task xpComponents) dicari lewat refleksi oleh XPCompiled.
-keep class dev.xp.generated.XPComponents { public static final dev.xp.generated.XPComponents INSTANCE; }
-keep class dev.xp.generated.XPTypedComponents { public static final dev.xp.generated.XPTypedComponents INSTANCE; }
