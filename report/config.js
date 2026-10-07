// 本物の入力画面の設定。
//
// ■ このファイルは公開される。書くのは、入力画面用のデプロイの GAS の URL（合言葉は付けない）と、
//   LINE ミニアプリの LIFF ID だけ。どちらも秘密ではない。
//   合言葉の入った Webhook の URL は、ここにもどこにも書かない。

var REPORT_CONFIG = {
  // 入力画面用のデプロイの URL（GAS の「デプロイを管理」に出るウェブアプリの URL。末尾は /exec。合言葉は付けない）
  gasUrl: 'https://script.google.com/macros/s/AKfycbw_mbIdj-VDmhw9vkVMH2xK8g6IFID7jtqYaj2WoJ19qzaJrpeKfSWqx-22aQd-0U3COQ/exec',
  // LINE ミニアプリの「ウェブアプリ設定」の LIFF ID（開発用と、公開用（本番用））
  liffIds: { dev: '2011911530-VIe15yGt', pub: '2011911532-nNmkrz4Z' },
};
