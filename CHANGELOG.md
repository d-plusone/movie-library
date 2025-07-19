# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- 自動サムネイル生成ワークフロー
  - ディレクトリ追加時の自動スキャン→サムネイル生成
  - 再スキャン完了時の自動サムネイル生成
- サブディレクトリ完全サポート
  - 選択フォルダのサブディレクトリも自動スキャン
  - フォルダフィルタでサブフォルダ内コンテンツも表示
- 統合プログレス管理システム
  - 長時間処理の進捗表示統一
  - オーナープログレスによるモーダル制御
- TypeScript化による型安全性向上
  - レンダラープロセスのTypeScript移行
  - 型定義の整備

### Changed
- デフォルトソートを作成日の降順に変更
- ディレクトリフィルタリング logic の改善
  - サブディレクトリ内容の適切な表示
  - 境界検出による精密なパスマッチング

### Fixed
- MOVファイルの表示問題を解決
- サブフォルダ内動画の表示問題を解決
- ディレクトリフィルタの部分マッチ問題を解決

## [0.0.6] - 2025-01-20

### Added
- 基本的な動画管理機能
- サムネイル生成機能
- 評価・タグ管理システム
- ダークテーマ対応
- キーボードナビゲーション

### Technical
- Electron 27ベース
- SQLite3データベース
- FFmpeg統合
- macOS (Intel + Apple Silicon), Windows対応
