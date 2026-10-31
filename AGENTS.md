# 公開方針

- 公開を依頼されたら、原則として次の両方を同じ最新版に更新すること。画面だけの変更も対象。
  - GitHub Pages: https://itachi-kun-itc.github.io/CopyNotes/
  - Cloudflare Pages: https://copynotes-bjx.pages.dev/
- GitHub Pagesはmainの更新によるActions、Cloudflare Pagesは `npm run deploy:api` で公開する。コミット済みの最新版を両方へ再公開するコマンドは `npm run deploy`。
- 公開前に構文チェック・テスト・対象環境のビルドを実行し、公開後は両方で変更されたファイルの配信を確認すること。
