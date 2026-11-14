@echo off
rem Windows launcher so `intentguard` works from PowerShell / cmd once the plugin is enabled.
node "%~dp0intentguard.js" %*
