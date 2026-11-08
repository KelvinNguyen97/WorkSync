/**
 * Japanese for the messages the main process sends when it refuses something
 * or cannot do it. {0}, {1}… are the parts that change, such as a file name
 * or a number; they are matched in the English and put into the Japanese.
 */
export const ERRORS_JA: [string, string][] = [
  [
    'This backup was made by a newer version of WorkSync. Use that version to restore it.',
    'このバックアップは新しい版の WorkSync で作られました。その版で復元してください。',
  ],
  [
    'This file is not a WorkSync backup, or it is damaged.',
    'このファイルは WorkSync のバックアップではないか、壊れています。',
  ],
  [
    'The copy of the last version read is missing. Check the file under Files so WorkSync reads it again.',
    '最後に読んだ版のコピーがありません。「ファイル」でファイルを確認し、もう一度読み込ませてください。',
  ],
  [
    'The file has a new version. Review it first, so the copy is not based on an old file.',
    'ファイルに新しい版があります。古いファイルを元にしないよう、先に確認してください。',
  ],
  [
    'WorkSync cannot write {0} files.',
    'WorkSync は {0} ファイルに書き込めません。',
  ],
  ['Nothing to write.', '書き込むものはありません。'],
  [
    'Cell {0} did not get its new value.',
    'セル {0} に新しい値が入りませんでした。',
  ],
  [
    'Cell {0} on {1} changed although it should not have.',
    '{1} のセル {0} が、変わらないはずなのに変わりました。',
  ],
  [
    'The copy failed its check and was not saved: {0}',
    'コピーが確認に失敗したため保存しませんでした: {0}',
  ],
  [
    'This data was saved by a newer version of WorkSync (database version {0}). Use that version or newer.',
    'このデータは新しい版の WorkSync で保存されています（データベースの版 {0}）。その版以降を使ってください。',
  ],
  [
    'The linked file was not found. Link it again at its new place.',
    'リンクしたファイルが見つかりません。新しい場所でリンクし直してください。',
  ],
  [
    'The data folder {0} is on a network drive, where the database can be damaged. Move the WorkSync folder to a local drive, such as C: or D:, and start it again.',
    'データフォルダー {0} はネットワークドライブにあり、データベースが壊れるおそれがあります。WorkSync フォルダーを C: や D: などのローカルドライブに移して、起動し直してください。',
  ],
  [
    'The data could not be opened. Restart WorkSync.',
    'データを開けませんでした。WorkSync を再起動してください。',
  ],
  ['Choose the file again.', 'ファイルをもう一度選んでください。'],
  ['Search for it again first.', '先にもう一度検索してください。'],
  [
    '{0} was not found. It may have been moved or deleted.',
    '{0} が見つかりません。移動または削除された可能性があります。',
  ],
  ['This address is not in the note.', 'このアドレスはノートにありません。'],
  [
    'That shortcut is used by another app or by Windows. Choose another one.',
    'このショートカットはほかのアプリか Windows が使っています。別のものを選んでください。',
  ],
  [
    '{0} has no sheet “{1}”. Choose the same customer file.',
    '{0} にシート「{1}」がありません。同じお客様ファイルを選んでください。',
  ],
  [
    'This link is not saved on a task.',
    'このリンクはタスクに保存されていません。',
  ],
  [
    '{0} was not found. The shared folder may not be connected.',
    '{0} が見つかりません。共有フォルダーにつながっていない可能性があります。',
  ],
  [
    'The sheet “{0}” is no longer in the file.',
    'シート「{0}」はもうファイルにありません。',
  ],
  [
    'Only files WorkSync saved in this session can be opened from here.',
    'ここから開けるのは、今回 WorkSync が保存したファイルだけです。',
  ],
  [
    'This project has not been published yet.',
    'このプロジェクトはまだ公開していません。',
  ],
  ['Choose the backup again.', 'バックアップをもう一度選んでください。'],
  [
    'This task was not found. It may have been completed.',
    'このタスクが見つかりません。完了した可能性があります。',
  ],
  ['A task needs a title.', 'タスクにはタイトルが必要です。'],
  [
    'The status must be Todo or On-going.',
    '状態は「未着手」か「対応中」にしてください。',
  ],
  [
    'The priority must be Urgent, Normal or Low.',
    '優先度は「緊急」「通常」「低」のどれかにしてください。',
  ],
  ['The due date is not a date.', '期限が日付になっていません。'],
  [
    'This note was not found. It may have been deleted.',
    'このノートが見つかりません。削除された可能性があります。',
  ],
  ['That project no longer exists.', 'そのプロジェクトはもうありません。'],
  [
    'This entry was not found in the Catalog.',
    'この項目はカタログにありません。',
  ],
  ['Choose a file or folder.', 'ファイルかフォルダーを選んでください。'],
  ['An entry is a file or a folder.', '項目はファイルかフォルダーです。'],
  ['{0} is already in the Catalog.', '{0} はすでにカタログにあります。'],
  ['The project was not found.', 'プロジェクトが見つかりません。'],
  [
    'This file is too large to be a WorkSync project.',
    'WorkSync のプロジェクトとしては大きすぎるファイルです。',
  ],
  [
    'This file is not a WorkSync project, or it is damaged.',
    'このファイルは WorkSync のプロジェクトではないか、壊れています。',
  ],
  [
    'This project was exported by a newer version of WorkSync. Update WorkSync to import it.',
    'このプロジェクトは新しい版の WorkSync で書き出されました。取り込むには WorkSync を更新してください。',
  ],
  ['Choose the publish folder first.', '先に公開フォルダーを選んでください。'],
  [
    'The publish folder cannot be reached: {0}',
    '公開フォルダーにアクセスできません: {0}',
  ],
  ['{0} is made as {1}.', '{0} は {1} として作られます。'],
  [
    'This linked file no longer exists.',
    'このリンクしたファイルはもうありません。',
  ],
  [
    'Some values have no meaning yet: {0}. Map them first.',
    '意味が決まっていない値があります: {0}。先に対応を決めてください。',
  ],
  [
    'No task rows were found with this file format.',
    'このファイル形式ではタスクの行が見つかりませんでした。',
  ],
  [
    'The sheet “{0}” of {1} is already linked to this project. Review its changes under Files instead, or link another sheet.',
    '{1} のシート「{0}」はすでにこのプロジェクトにリンクしています。「ファイル」で変更を確認するか、別のシートをリンクしてください。',
  ],
  ['Map the new values first.', '先に新しい値の対応を決めてください。'],
  [
    'Join each task to one row only.',
    '各タスクは 1 つの行だけにつなげてください。',
  ],
  [
    'A row can only be joined to a task of this file that is no longer in it.',
    '行をつなげられるのは、このファイルから消えたタスクだけです。',
  ],
  [
    'Due soon must be between 1 and 60 days.',
    '期限間近の日数は 1〜60 日にしてください。',
  ],
  [
    'Choose System, Light or Dark.',
    '「システム」「ライト」「ダーク」から選んでください。',
  ],
  [
    'Choose the app language from the list.',
    'アプリの言語を一覧から選んでください。',
  ],
  ['Project {0} not found', 'プロジェクト {0} が見つかりません'],
  ['A project needs a name.', 'プロジェクトには名前が必要です。'],
  [
    'Choose at least one original language.',
    '原文の言語を 1 つ以上選んでください。',
  ],
  [
    'There is already a column called {0}. Choose another name.',
    '{0} という列がすでにあります。別の名前にしてください。',
  ],
  ['That Board column no longer exists.', 'そのボードの列はもうありません。'],
  ['Set the status to {0} first.', '先に状態を {0} にしてください。'],
  ['Task {0} not found', 'タスク {0} が見つかりません'],
  [
    'The planned end is before the planned start.',
    '予定終了が予定開始より前です。',
  ],
  [
    'The actual end is before the actual start.',
    '実績終了が実績開始より前です。',
  ],
  [
    'No. {0} is already used by another task in this project. Choose another number, or leave it empty for the next one.',
    'No. {0} はこのプロジェクトの別のタスクが使っています。別の番号にするか、空にして次の番号を使ってください。',
  ],
  [
    'The No. and description come from the customer’s file. They change when the file does.',
    'No. と説明はお客様ファイルの値です。ファイルが変わると変わります。',
  ],
  [
    '{0} is not a web address or a file path. Use one such as https://… or \\\\server\\share\\spec.xlsx.',
    '{0} はウェブアドレスでもファイルパスでもありません。https://… や \\\\server\\share\\spec.xlsx のように入力してください。',
  ],
  [
    'This task has no situation yet. Use Update situation.',
    'このタスクにはまだ状況がありません。「状況を更新」を使ってください。',
  ],
  ['This difficulty was not found.', 'この課題が見つかりません。'],
  [
    'A difficulty needs some text. To remove it, delete it.',
    '課題には内容が必要です。消すときは削除してください。',
  ],
  ['The entry is empty.', '記録が空です。'],
  [
    'A glossary entry needs the term and its translation.',
    '用語集には用語と訳の両方が必要です。',
  ],
  [
    '{0} is already in the glossary as “{1}”. Change that entry instead, so the term has one translation.',
    '{0} はすでに用語集に「{1}」としてあります。訳が 1 つになるよう、その項目を変更してください。',
  ],
  [
    'A person needs the name as written in the files.',
    '人にはファイルでの表記が必要です。',
  ],
  [
    '{0} already has that name or spelling.',
    '{0} がすでにその名前か表記を持っています。',
  ],
  [
    'The sheet “{0}” was not found in the workbook.',
    'ブックにシート「{0}」が見つかりません。',
  ],
  ['The sheet has no cell data.', 'シートにセルのデータがありません。'],
  [
    'This folder holds a linked customer file ({0}). Choose {1} instead.',
    'このフォルダーにはリンクしたお客様ファイル（{0}）があります。代わりに{1}を選んでください。',
  ],
  [
    'This folder is inside Box, where the customer could see it. Choose {0}.',
    'このフォルダーは Box の中にあり、お客様から見える可能性があります。{0}を選んでください。',
  ],
  [
    'WorkSync reads .xlsx, .xlsm, .xls and .csv files.',
    'WorkSync が読めるのは .xlsx、.xlsm、.xls、.csv ファイルです。',
  ],
  [
    'The sheet “{0}” is no longer in {1}.',
    'シート「{0}」はもう {1} にありません。',
  ],
  [
    'This file is damaged or is not an Excel workbook.',
    'このファイルは壊れているか、Excel のブックではありません。',
  ],
  [
    'This file is protected with an opening password. Open it in Excel, save a copy without the password in a private folder, and link that copy.',
    'このファイルには読み取りパスワードがあります。Excel で開き、パスワードなしのコピーを自分用のフォルダーに保存して、そのコピーをリンクしてください。',
  ],
  [
    'The file could not be read as a workbook: {0}',
    'ファイルをブックとして読めませんでした: {0}',
  ],
  ['This file has no sheets.', 'このファイルにはシートがありません。'],
  [
    'This .xls file is protected with a password.',
    'この .xls ファイルはパスワードで保護されています。',
  ],
  ['The sheet {0} is not in the file.', 'シート {0} はファイルにありません。'],

  // Toasts built in the screens, translated as they are shown.
  [
    'Linked {0}. Added {1} task{2}, skipped {3} row{4}.',
    '{0} をリンクしました。{1} 件のタスクを追加し、{3} 行を飛ばしました。',
  ],
  [
    'Linked {0}. Added {1} task{2}.',
    '{0} をリンクしました。{1} 件のタスクを追加しました。',
  ],
  [
    'Request {0} of {1} copied. Paste it into Gemini.',
    '依頼文 {0}/{1} をコピーしました。Gemini に貼り付けてください。',
  ],
  [
    'Filled in {0} task{1}. You can still edit each one.',
    '{0} 件のタスクに反映しました。それぞれ後から編集できます。',
  ],
  ['Added {0} to the glossary.', '{0} を用語集に追加しました。'],
  [
    'Removed {0} from the Catalog. The {1} itself is untouched.',
    '{0} をカタログから外しました。ファイルやフォルダー自体はそのままです。',
  ],
  ['Added {0} to the Catalog.', '{0} をカタログに追加しました。'],
  [
    'Deleted {0} and its {1} task{2}. A backup was made first; restore it from Settings if you need it back.',
    '{0} と {1} 件のタスクを削除しました。先にバックアップしたので、必要なら設定から復元できます。',
  ],
  [
    'Deleted {0}. Its tasks are back in {1}.',
    '{0} を削除しました。タスクは「{1}」に戻りました。',
  ],
  ['Deleted {0}.', '{0} を削除しました。'],
  [
    'Saved {0}. Give it to the other person; they use Import a project.',
    '{0} を保存しました。相手に渡し、「プロジェクトを取り込む」で取り込んでもらってください。',
  ],
  [
    'Applied: {0} new, {1} changed, {2} removed. Each task’s history records it.',
    '反映しました: 新規 {0}、変更 {1}、削除 {2}。各タスクの履歴に記録しています。',
  ],
  ['Saved {0} with {1} task{2}.', '{0} を保存しました（タスク {1} 件）。'],
  [
    'Request {0} of {1} copied. Paste it into Gemini, then paste the answer here.',
    '依頼文 {0}/{1} をコピーしました。Gemini に貼り付け、回答をここに貼り付けてください。',
  ],
  ['Saved {0} translations of {1}.', '{1} の翻訳を {0} 件保存しました。'],
  ['Copied the briefs of {0}.', '{0} の概要をコピーしました。'],
  ['{0} moved to {1}.', '{0} を「{1}」に移しました。'],
  [
    'Added the column {0}, under {1}.',
    '列「{0}」を追加しました（状態: {1}）。',
  ],
  [
    'Saved {0}. {1} cell{2} changed, every other cell checked.',
    '{0} を保存しました。{1} 個のセルを変更し、ほかのセルはすべて確認しました。',
  ],
  ['{0} is now {1}.', '{0} の優先度を「{1}」にしました。'],
  [
    '{0} is {1} for you. The file still says {2}.',
    '{0} は自分用に「{1}」です。ファイルは「{2}」のままです。',
  ],
  [
    'Override removed. {0} is {1}, as in the file.',
    '上書きを外しました。{0} はファイルと同じ「{1}」です。',
  ],
  [
    'Override removed. {0} is {1} again.',
    '上書きを外しました。{0} は再び「{1}」です。',
  ],
  ['{0} entries of {1} saved.', '{1} の {0} 件を保存しました。'],
];

/** Parts that fill {0}… and have their own Japanese, such as where to choose instead. */
export const ERROR_PARTS_JA: Record<string, string> = {
  'another folder': '別のフォルダー',
  'a folder on your PC, outside Box and the linked file’s folder':
    'Box とリンクしたファイルのフォルダー以外の、PC 上のフォルダー',
  'a folder on the company shared drive': '社内の共有ドライブのフォルダー',
  Done: '完了',
  'In progress': '対応中',
  'In review': '確認中',
  'On hold': '保留',
  'Not started': '未着手',
  Cancelled: '中止',
};
