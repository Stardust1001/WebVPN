@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set PATH=%PATH%;C:\Users\Stardust\.cargo\bin
set RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc
cd /d C:\Users\Stardust\Desktop\WebVPN\rust
echo === RUSTUP_TOOLCHAIN=%RUSTUP_TOOLCHAIN% === > build.log
echo === NO --target, host=x86_64 === >> build.log
rustc -vV >> build.log 2>&1
echo === BUILD START === >> build.log
cargo build --release >> build.log 2>&1
echo CARGO_EXIT=%errorlevel% >> build.log
