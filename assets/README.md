# アイコンファイルについて

このディレクトリには以下のアイコンファイルを配置してください：

## macOS用
- `icon.icns` - macOS用のアイコンファイル (1024x1024推奨)

## Windows用  
- `icon.ico` - Windows用のアイコンファイル (256x256推奨)

## アイコンファイルの作成方法

1. **オンラインツールを使用**:
   - [IconConvert](https://iconverticons.com/online/)
   - [Convertio](https://convertio.co/png-icns/)

2. **macOSでの変換**:
   ```bash
   # PNGからICNSに変換
   mkdir icon.iconset
   sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
   iconutil -c icns icon.iconset
   ```

3. **Windowsでの変換**:
   - GIMP、Photoshop、またはオンラインツールを使用してPNGからICOに変換

## 推奨サイズ
- 元画像: 1024x1024 PNG (透明背景推奨)
- フラットデザインまたはシンプルなデザインが推奨

アイコンファイルを配置したら、このREADMEファイルは削除してください。
