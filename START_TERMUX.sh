#!/data/data/com.termux/files/usr/bin/bash
set -e
pkg update -y
pkg install nodejs-lts python ffmpeg -y || pkg install nodejs python ffmpeg -y
python -m pip install -U yt-dlp
npm install
cp -n .env.example .env || true
sed -i 's/^HOST=.*/HOST=127.0.0.1/' .env
npm start
