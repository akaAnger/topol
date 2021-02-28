const { Composer } = require('telegraf');
const Markup = require('telegraf/markup');
const Extra = require('telegraf/extra');
const { Languages, LoadReplies } = require('../replies/replies');
const rp = require('../replies/replies');
const { dbManagement, Schedule, User, Chat } = require('../../backend/dataBase/db');
const { arrayParseString } = require('@alordash/parse-word-to-number');
const { wordsParseDate, TimeList } = require('@alordash/date-parser');
const { FormStringFormatSchedule, FormDateStringFormat, FormBoardsList, FormBoardListsList, FormListBinded } = require('../formatting');
const path = require('path');
const { Encrypt, Decrypt } = require('../../backend/encryption/encrypt');
const { TimeListFromDate, ProcessParsedDate } = require('../../backend/timeProcessing');
const { TrelloManager } = require('@alordash/node-js-trello');
const { trelloAddBoardCommand, trelloBindBoardCommand, trelloAddListCommand } = require('./botCommands');
const { type } = require('os');

/**@type {Array.<Array.<Schedule>>} */
let pendingSchedules = [];

/**
 * @param {Number} x 
 * @returns {Number} 
 */
Number.prototype.div = function (x) {
   return Math.floor(this / x);
}

/**@param {String} string
 * @returns {Languages}
 */
function DetermineLanguage(string) {
   let ruCount = [...string.matchAll(/[А-Яа-я]/g)].length;
   let enCount = [...string.matchAll(/[A-Za-z]/g)].length;
   return ruCount > enCount ? Languages.RU : Languages.EN;
}

/**
 * @param {Array.<Number>} tz 
 * @param {Array.<Number>} trello 
 * @param {Number} id 
 */
function ClearPendingConfirmation(tzs, trellos, id) {
   let index = tzs.indexOf(id)
   if (index >= 0) {
      tzs.splice(index, 1);
   }
   index = trellos.indexOf(id);
   if (index >= 0) {
      trellos.splice(index, 1);
   }
}

function GetDeletingIDsIndex(chatID, deletingIDs) {
   if (deletingIDs.length) {
      for (let i in deletingIDs) {
         if (deletingIDs[i].chatID == chatID) {
            return i;
         }
      }
   }
   return false;
}
/**
 * @param {Number} id 
 * @returns {String} 
 */
function FormatChatId(id) {
   id = id.toString(10);
   if (id[0] == '-') {
      id = '_' + id.substring(1);
   }
   return id;
}

/**@returns {String} */
function GetAttachmentId(message) {
   if (typeof (message.document) != 'undefined') {
      return message.document.file_id;
   } else if (typeof (message.video) != 'undefined') {
      return message.video.file_id;
   } else if (typeof (message.photo) != 'undefined' && message.photo.length > 0) {
      let photoes = message.photo;
      let file_id = photoes[0].file_id;
      let file_size = photoes[0].file_size;
      for (let i = 1; i < photoes.length; i++) {
         const photo = photoes[i];
         if (photo.file_size > file_size) {
            file_size = photo.file_size;
            file_id = photo.file_id;
         }
      }
      return file_id;
   }
   return '~';
}

async function SendAttachment(bot, schedule, chatID, caption, keyboard) {
   let file_info = await bot.telegram.getFile(schedule.file_id);
   let file_path = path.parse(file_info.file_path);
   if (file_path.dir == 'photos') {
      return await bot.telegram.sendPhoto(chatID, schedule.file_id, {
         caption,
         ...keyboard
      });
   } else if (file_path.dir == 'videos') {
      return await bot.telegram.sendVideo(chatID, schedule.file_id, {
         caption,
         ...keyboard
      });
   } else {
      return await bot.telegram.sendDocument(chatID, schedule.file_id, {
         caption,
         ...keyboard
      });
   }
}

/**
 * @param {String} chatID 
 * @param {Number} tsOffset 
 * @param {dbManagement} db 
 * @param {Languages} language
 * @returns {Array.<String>}
 */
async function LoadSchedulesList(chatID, tsOffset, db, language) {
   let schedules = await db.ListSchedules(chatID);
   if (schedules.length > 0) {
      let answers = [];
      let answer = ``;
      schedules.sort((a, b) => a.target_date - b.target_date);
      for (let schedule of schedules) {
         schedule.target_date = +schedule.target_date;
         schedule.period_time = +schedule.period_time;
         schedule.max_date = +schedule.max_date;
         let newAnswer = `${await FormStringFormatSchedule(schedule, tsOffset, language, false, db)}\r\n`;
         if (answer.length + newAnswer.length > global.MaxMessageLength) {
            answers.push(answer);
            answer = newAnswer;
         } else {
            answer += newAnswer;
         }
      }
      if (answer.length > 0) {
         answers.push(answer);
      }
      return answers;
   } else {
      const replies = LoadReplies(language);
      return [replies.listIsEmpty];
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {Languages} 
 */
async function DeleteSchedules(ctx, db) {
   let chatID = FormatChatId(ctx.chat.id)
   let msgText = ctx.message.text;
   const replies = LoadReplies(ctx.from.language_code);
   if (msgText.indexOf('all') == "/del ".length) {
      await db.ClearAllSchedules(chatID);
      await ctx.replyWithHTML(replies.cleared);
   } else {
      let nums = msgText.match(/[0-9]+/g);
      let ranges = msgText.match(/[0-9]+-[0-9]+/g);
      for (let i in nums) {
         nums[i] = parseInt(nums[i], 10);
      }
      for (let i in ranges) {
         let range = ranges[i];
         let index = range.indexOf('-');
         let leftNum = +range.substring(0, index);
         let rightNum = +range.substring(index + 1);
         if (leftNum > rightNum) {
            let t = leftNum;
            leftNum = rightNum;
            rightNum = t;
         }
         for (let j = leftNum; j <= rightNum && j - leftNum <= 10; j++) {
            nums.push(j);
         }
      }
      if (nums != null) {
         nums = nums.filter((item, pos) => {
            return nums.indexOf(item) == pos;
         });
         nums.sort((a, b) => a - b);

         let query = '';
         for (let i in nums) {
            let schedule = nums[i];
            query += `id = ${schedule} OR `;
         }
         query = query.substring(0, query.length - 4);
         await db.RemoveSchedules(chatID, query);
         await db.ReorderSchedules(chatID);
         let end = '';
         if (nums.length > 1) {
            end = 's';
         }
         try {
            ctx.replyWithHTML(rp.Deleted(nums.join(', '), false, ctx.message.from.language_code));
         } catch (e) {
            console.error(e);
         }
      } else {
         try {
            ctx.replyWithHTML(replies.invalidDelete);
         } catch (e) {
            console.error(e);
         }
      }
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {Array.<Number>} tzPendingConfirmationUsers 
 */
async function StartTimeZoneDetermination(ctx, db, tzPendingConfirmationUsers) {
   let curTZ = await db.GetUserTZ(ctx.from.id);
   let reply = '';
   const language = await db.GetUserLanguage(ctx.from.id);
   const replies = LoadReplies(language);
   if (curTZ !== 0) {
      reply = replies.tzDefined + '<b>' + rp.TzCurrent(curTZ) + '</b>\r\n';
   }
   let isPrivateChat = ctx.chat.id >= 0;
   if (isPrivateChat) {
      reply += replies.tzConfiguration + '\r\n' + replies.tzViaLoc + '\r\n' + replies.tzManually;
      try {
         return ctx.replyWithHTML(reply, rp.TzDeterminationKeyboard(language));
      } catch (e) {
         console.error(e);
      }
   }
   if (tzPendingConfirmationUsers.indexOf(ctx.from.id) < 0) {
      tzPendingConfirmationUsers.push(ctx.from.id);
   }
   try {
      return await ctx.replyWithHTML(replies.tzGroupChatConfiguration);
   } catch (e) {
      console.error(e);
   }
}

/**
 * @param {Composer} bot 
 * @param {dbManagement} db 
 */
async function CheckExpiredSchedules(bot, db) {
   console.log('Checking expired schedules ' + new Date());
   db.sending = true;
   let now = Date.now();
   let expiredSchedules = await db.CheckActiveSchedules(now);
   if (expiredSchedules.length > 0) {
      console.log(`expiredSchedules = ${JSON.stringify(expiredSchedules)}`);
      let ChatIDs = [];
      let deletingIDs = [];
      for (let schedule of expiredSchedules) {
         let chatID = schedule.chatid;
         if (chatID[0] == '_') {
            chatID = '-' + chatID.substring(1, chatID.length);
         }
         let expired = true;
         if (schedule.trello_card_id != null) {
            try {
               let chat = await db.GetChatById(chatID);
               let trelloManager = new TrelloManager(process.env.TRELLO_KEY, chat.trello_token);
               let card = await trelloManager.GetCard(schedule.trello_card_id);
               if (typeof (card) != 'undefined' && typeof (card.due) != 'undefined') {
                  let dueTime = new Date(card.due).getTime();
                  if (now < dueTime) {
                     expired = false;
                     db.SetScheduleTargetDate(schedule.chatid, schedule.id, dueTime);
                  }
               }
            } catch (e) {
               console.log(e);
            }
         }
         if (!expired) {
            continue;
         }
         console.log(`Expired schedule = ${JSON.stringify(schedule)}`);
         if (!ChatIDs.includes(schedule.chatid)) {
            ChatIDs.push(schedule.chatid);
         }
         let mentionUser = '';
         if (schedule.username != 'none') {
            mentionUser = ' @' + schedule.username;
         }
         let language = await db.GetUserLanguage(+chatID);
         const replies = LoadReplies(language);
         let isBlocked = false;
         try {
            let keyboard = Extra.markup((m) =>
               m.inlineKeyboard([
                  m.callbackButton(replies.repeatSchedule, `repeat`)
               ]).oneTime()
            );
            let msg;
            let remindIcon = '⏰';
            let scheduleId = '';
            if (schedule.period_time > 0) {
               remindIcon = '🔄';
               scheduleId = ` /${schedule.id}`
            }

            const remindText = `${remindIcon}${scheduleId}${mentionUser} "${Decrypt(schedule.text, schedule.chatid)}"`;
            try {
               if (schedule.file_id != '~' && schedule.file_id != null) {
                  msg = await SendAttachment(bot, schedule, +chatID, remindText, keyboard);
               } else {
                  msg = await bot.telegram.sendMessage(+chatID, remindText, {
                     ...keyboard
                  });
               }
               setTimeout(function (msg) {
                  bot.telegram.editMessageReplyMarkup(msg.chat.id, msg.message_id, Extra.markup((m) =>
                     m.inlineKeyboard([]).removeKeyboard()
                  ));
               }, repeatScheduleTime, msg);
            } catch (e) {
               console.error(e);
               isBlocked = true;
            }
         } catch (e) {
            console.error(e);
         }
         let shouldDelete = true;
         if (!isBlocked) {
            const nowSeconds = Date.now();
            schedule.target_date = +schedule.target_date;
            schedule.period_time = +schedule.period_time;
            schedule.max_date = +schedule.max_date;
            if (schedule.period_time >= 60 && schedule.max_date >= 60) {
               if (nowSeconds < schedule.max_date) {
                  shouldDelete = false;
                  await db.SetScheduleTargetDate(schedule.chatid, schedule.id, nowSeconds + schedule.period_time);
               }
            } else if (schedule.period_time >= 60 && schedule.max_date < 60) {
               shouldDelete = false;
               await db.SetScheduleTargetDate(schedule.chatid, schedule.id, nowSeconds + schedule.period_time);
            } else if (schedule.period_time < 60 && schedule.max_date >= 60) {
               if (nowSeconds < schedule.max_date) {
                  shouldDelete = false;
                  await db.SetScheduleTargetDate(schedule.chatid, schedule.id, schedule.max_date);
               }
            }
         }
         if (shouldDelete) {
            let index = GetDeletingIDsIndex(schedule.chatid, deletingIDs);
            if (index === false) {
               deletingIDs.push({ s: `id = ${schedule.id} OR `, chatID: schedule.chatid });
            } else {
               deletingIDs[index].s += `id = ${schedule.id} OR `;
            }
         }
      }
      console.log('CHECKED, removing and reordering');
      for (let chatID of ChatIDs) {
         let index = GetDeletingIDsIndex(chatID, deletingIDs);
         if (index !== false) {
            let s = deletingIDs[index].s;
            s = s.substring(0, s.length - 4);
            await db.RemoveSchedules(chatID, s);
         }
         await db.ReorderSchedules(chatID);
      }
      console.log('Removed and reordered.');
   }
   db.sending = false;
   console.log(`Done checking expired schedules`);
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {Array.<Number>} tzPendingConfirmationUsers 
 */
async function ConfrimTimeZone(ctx, db, tzPendingConfirmationUsers) {
   let userId = ctx.from.id;
   let matches = ctx.message.text.match(/(\+|-|–|—|)([0-9])+:([0-9])+/g);
   let hours, minutes, negative, ts;
   const replies = LoadReplies(ctx.from.language_code);
   if (matches != null) {
      //Parse tz from msg;
      let offset = matches[0];
      let index = offset.indexOf(':');
      hours = parseInt(offset.substring(0, index));
      negative = offset[0].match(/-|–|—/g) != null;
      minutes = parseInt(offset.substring(index + 1));
      console.log(`Determining tz: offset = ${offset}, hours = ${hours}, minutes = ${minutes}, ts = ${ts}`);
   } else {
      matches = ctx.message.text.match(/(\+|-|–|—|)([0-9])+/g);
      if (matches != null) {
         let offset = matches[0];
         hours = parseInt(offset);
         minutes = 0;
         negative = offset[0].match(/-|–|—/g) != null;
         console.log(`Determining tz from only hour option: offset = ${offset}, hours = ${hours}, minutes = ${minutes}, ts = ${ts}`);
      }
   }
   if (matches != null) {
      let ts = hours * 3600;
      ts += minutes * 60 * (negative ? -1 : 1);
      if (!await db.HasUserID(userId)) {
         await db.AddUser(new User(userId, ts, db.defaultUserLanguage));
      } else {
         await db.SetUserTz(userId, ts);
      }
      tzPendingConfirmationUsers.splice(tzPendingConfirmationUsers.indexOf(ctx.from.id), 1);
      try {
         const schedulesCount = (await db.GetSchedules(FormatChatId(ctx.chat.id))).length;
         ctx.replyWithHTML(replies.tzDefined + '<b>' + rp.TzCurrent(ts) + '</b>\r\n',
            schedulesCount > 0 ? rp.ListKeyboard(ctx.from.language_code) : Markup.removeKeyboard());
      } catch (e) {
         console.error(e);
      }
   } else {
      console.log(`Can't determine tz in "${ctx.message.text}"`);
      try {
         return ctx.replyWithHTML(replies.tzInvalidInput, rp.CancelButton(ctx.from.language_code));
      } catch (e) {
         console.error(e);
      }
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {Array.<Number>} tzPendingConfirmationUsers
 */
async function HandleCallbackQuery(ctx, db, tzPendingConfirmationUsers) {
   console.log("got callback_query");
   const data = ctx.callbackQuery.data;
   let chatID = FormatChatId(ctx.callbackQuery.message.chat.id);
   const language = await db.GetUserLanguage(ctx.from.id);
   const replies = LoadReplies(language);
   switch (data) {
      case 'repeat':
         let hasCaption = false;
         let msgText = ctx.callbackQuery.message.text;
         if (typeof (msgText) == 'undefined') {
            hasCaption = true;
            msgText = ctx.callbackQuery.message.caption;
         }
         let text = msgText.match(/"[\S\s]+"/);
         text = text[0].substring(1, text[0].length - 1);
         let username = 'none';
         if (chatID[0] === '_') {
            username = ctx.from.username;
         }
         let file_id = GetAttachmentId(ctx.callbackQuery.message);
         let schedulesCount = await db.GetSchedules(chatID).length;
         let target_date = Date.now() + global.repeatScheduleTime;
         let schedule = new Schedule(chatID, schedulesCount, text, username, target_date, 0, 0, file_id);
         let tz = await db.GetUserTZ(ctx.from.id);

         try {
            await db.AddSchedule(schedule);
            let newText = text + '\r\n' + replies.remindSchedule + ' <b>' + FormDateStringFormat(new Date(target_date + tz * 1000), language, false) + '</b>';
            if (hasCaption) {
               ctx.editMessageCaption(newText, { parse_mode: 'HTML' });
            } else {
               ctx.editMessageText(newText, { parse_mode: 'HTML' });
            }
         } catch (e) {
            console.error(e);
         }
         break;
      case 'confirm':
         try {
            if (typeof (pendingSchedules[chatID]) != 'undefined' && pendingSchedules[chatID].length > 0) {
               await SaveToTrello(ctx, db, pendingSchedules, chatID);
               await db.AddSchedules(chatID, pendingSchedules[chatID]);
            }
         } catch (e) {
            console.error(e);
         } finally {
            pendingSchedules[chatID] = [];
            ctx.editMessageReplyMarkup(Extra.markup((m) =>
               m.inlineKeyboard([]).removeKeyboard()
            ));
         }
         break;
      case 'delete':
         ctx.deleteMessage();
         break;
      case 'unsubscribe':
         await db.SetUserSubscription(ctx.from.id, false);
         break;
      case 'startTZ':
         try {
            let language = await db.GetUserLanguage(ctx.from.id);
            ctx.from.language_code = language;
            ctx.editMessageReplyMarkup(Extra.markup((m) =>
               m.inlineKeyboard([]).removeKeyboard()
            ));
            await StartTimeZoneDetermination(ctx, db, tzPendingConfirmationUsers);
         } catch (e) {
            console.error(e);
         }
         break;
      default:
         break;
   }
   try {
      ctx.answerCbQuery();
   } catch (e) {
      console.error(e);
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {Array.<Number>} tzPendingConfirmationUsers 
 * @param {Array.<Number>} trelloPendingConfirmationUsers 
 */
async function HandleTextMessage(bot, ctx, db, tzPendingConfirmationUsers, trelloPendingConfirmationUsers) {
   let chatID = FormatChatId(ctx.chat.id)
   let inGroup = chatID[0] === '_';
   let msgText = ctx.message.text;
   if (typeof (msgText) == 'undefined') {
      msgText = ctx.message.caption;
   }
   if (typeof (msgText) != 'undefined' && (!inGroup || (inGroup && typeof (ctx.message.forward_date) == 'undefined'))) {
      const language = DetermineLanguage(msgText);
      ctx.from.language_code = language;

      const mentionText = `@${ctx.me}`;
      const mentionIndex = msgText.indexOf(mentionText);
      const mentioned = mentionIndex != -1;
      if (mentioned) {
         msgText = msgText.substring(0, mentionIndex) + msgText.substring(mentionIndex + mentionText.length);
         if (msgText[mentionIndex - 1] == ' ' && msgText[mentionIndex] == ' ') {
            msgText = msgText.substring(0, mentionIndex) + msgText.substring(mentionIndex + 1);
         }
      }
      if (tzPendingConfirmationUsers.indexOf(ctx.from.id) >= 0) {
         ConfrimTimeZone(ctx, db, tzPendingConfirmationUsers);
      } else if (trelloPendingConfirmationUsers.indexOf(ctx.from.id) >= 0) {
         TrelloAuthenticate(ctx, db, trelloPendingConfirmationUsers)
      } else {
         let reply = '';
         if (msgText[0] == '/') {
            let regExp = new RegExp(`^${trelloAddBoardCommand}[0-9]+`);
            let match = msgText.match(regExp);
            if (match != null) {
               //#region ADD TRELLO BOARD
               TrelloAddBoard(ctx, db);
               return;
               //#endregion
            }
            regExp = new RegExp(`^${trelloAddListCommand}[0-9]+`);
            match = msgText.match(regExp);
            if (match != null) {
               //#region ADD TRELLO LIST
               TrelloAddList(ctx, db);
               return;
               //#endregion
            }
            //#region DELETE CLICKED TASK 
            let scheduleId = parseInt(msgText.substring(1, msgText.length));
            if (!isNaN(scheduleId)) {
               let schedule = await db.GetScheduleById(chatID, scheduleId);
               await db.RemoveScheduleById(chatID, scheduleId);
               await db.ReorderSchedules(chatID);
               try {
                  const text = rp.Deleted(scheduleId.toString(10), false, ctx.from.language_code);
                  if (schedule.file_id != '~' && schedule.file_id != null) {
                     SendAttachment(bot, schedule, chatID, text, {});
                  } else {
                     ctx.replyWithHTML(text);
                  }
               } catch (e) {
                  console.error(e);
               }
            }
            //#endregion
         } else {
            //#region PARSE SCHEDULE
            let file_id = GetAttachmentId(ctx.message);
            await db.SetUserLanguage(ctx.from.id, language);
            const replies = LoadReplies(language);
            let tz = await db.GetUserTZ(ctx.from.id);
            let prevalence = 50;
            let username = 'none';
            if (inGroup) {
               username = ctx.from.username;
               //            prevalence = 60;
            }
            let parsedDates = wordsParseDate(arrayParseString(msgText, 1), 1, prevalence, msgText);
            let count = 1;
            let shouldWarn = false;
            let schedulesCount = (await db.GetSchedules(chatID)).length;
            if (parsedDates.length == 0) {
               if (!inGroup) {
                  reply += replies.errorScheduling;
               }
            } else {
               console.log(`schedulesCount = ${schedulesCount}`);
               let parsedDateIndex = 0;
               let chat = await db.GetChatById(`${ctx.chat.id}`);
               let trelloIsOk = typeof (chat) != 'undefined' && chat.trello_list_id != null;
               let trelloManager = new TrelloManager(process.env.TRELLO_KEY, chat.trello_token);
               for (const si in pendingSchedules[chatID]) {
                  /**@type {Schedule} */
                  let schedule = pendingSchedules[chatID][si];
                  let text = schedule.text;
                  let i = text.indexOf(' ');
                  if (i < 0) {
                     i = undefined;
                  }
                  let card = await trelloManager.AddCard(chat.trello_list_id, text.substring(0, i), text, 0, new Date(schedule.target_date));

                  pendingSchedules[chatID][si].trello_card_id = card.id;
                  pendingSchedules[chatID][si].max_date = 0;
                  pendingSchedules[chatID][si].period_time = 0;
               }
               for (let parsedDate of parsedDates) {
                  let dateParams = ProcessParsedDate(parsedDate, tz, inGroup && !mentioned);
                  if (typeof (dateParams) != 'undefined') {
                     let schedules = await db.GetSchedules(chatID);
                     let found = false;
                     let i = 0;
                     for (; !found && i < schedules.length; i++) {
                        if (schedules[i].text == parsedDate.string) {
                           found = true;
                        }
                     }
                     if (found) {
                        let schedule = schedules[i - 1];
                        if (!inGroup) {
                           reply += rp.Scheduled(schedule.text, FormDateStringFormat(new Date(+schedule.target_date + tz * 1000), language, true), language);
                        }
                     } else {
                        if (count + schedulesCount < global.MaximumCountOfSchedules) {
                           if (parsedDate.string.length > 0) {
                              if (parsedDates.length > 1) {
                                 reply += `${parsedDateIndex + 1}. `;
                              }
                              if (typeof (pendingSchedules[chatID]) == 'undefined') {
                                 pendingSchedules[chatID] = [];
                              }
                              let newSchedule = new Schedule(
                                 chatID,
                                 schedules.length + parsedDateIndex + 1,
                                 parsedDate.string,
                                 username,
                                 dateParams.target_date,
                                 dateParams.period_time,
                                 dateParams.max_date,
                                 file_id);
                              if (trelloIsOk) {
                                 let text = newSchedule.text;
                                 let i = text.indexOf(' ');
                                 if (i < 0) {
                                    i = undefined;
                                 }
                                 let card = await trelloManager.AddCard(chat.trello_list_id, text.substring(0, i), text, 0, new Date(newSchedule.target_date));

                                 newSchedule.trello_card_id = card.id;
                                 newSchedule.max_date = 0;
                                 newSchedule.period_time = 0;
                              }
                              pendingSchedules[chatID].push(newSchedule);
                              count++;
                              reply += await FormStringFormatSchedule(newSchedule, tz, language, true, db) + `\r\n`;
                           } else if (!inGroup) {
                              reply += replies.emptyString + '\r\n';
                           }
                        } else {
                           reply += replies.shouldRemove + '\r\n' + replies.maximumSchedulesCount + ` <b>${global.MaximumCountOfSchedules}</b>.`;
                        }
                     }
                  } else if (!inGroup) {
                     reply += replies.errorScheduling + '\r\n';
                  }
                  if (!inGroup && !(await db.HasUserID(ctx.from.id))) {
                     shouldWarn = true;
                  }
                  parsedDateIndex++;
               }
            }
            if ((!inGroup || mentioned) && typeof (pendingSchedules[chatID]) != 'undefined' && pendingSchedules[chatID].length > 0) {
               await db.AddSchedules(chatID, pendingSchedules[chatID]);
               pendingSchedules[chatID] = [];
            }
            //#endregion
            if (reply != '') {
               if (shouldWarn) {
                  reply += replies.tzWarning;
               }
               try {
                  if (!mentioned && inGroup && typeof (schedule) === 'undefined' && parsedDates.length > 0) {
                     let keyboard;
                     if (typeof (pendingSchedules[chatID]) != 'undefined' && pendingSchedules[chatID].length > 0) {
                        keyboard = Extra.markup((m) =>
                           m.inlineKeyboard([
                              m.callbackButton(replies.confirmSchedule, `confirm`),
                              m.callbackButton(replies.declineSchedule, `delete`)
                           ]).oneTime()
                        )
                     }
                     let msg = await ctx.replyWithHTML(reply, keyboard);
                     setTimeout(function (ctx, msg) {
                        if (typeof (msg) != 'undefined') {
                           let chatID = FormatChatId(msg.chat.id);
                           ctx.telegram.deleteMessage(msg.chat.id, msg.message_id);
                           pendingSchedules[chatID] = [];
                        }
                     }, repeatScheduleTime, ctx, msg);
                  } else {
                     ctx.replyWithHTML(reply, schedulesCount > 0 ? rp.ListKeyboard(language) : Markup.removeKeyboard());
                  }
               } catch (e) {
                  console.error(e);
               }
            }
         }
      }
   }
}

/**
 * @param {*} ctx 
 * @param {User} user
 * @param {Array.<Number>} trelloPendingConfirmationUsers 
 */
async function TrelloCommand(user, ctx, trelloPendingConfirmationUsers) {
   if (user.trello_token == null) {
      trelloPendingConfirmationUsers.push(ctx.from.id);
      await ctx.replyWithHTML(rp.TrelloAuthorizationMessage(process.env.TRELLO_KEY, "Smart Scheduler", user.lang),
         rp.CancelKeyboard(user.lang));
   } else {
      let trelloManager = new TrelloManager(process.env.TRELLO_KEY, user.trello_token);
      let owner = await trelloManager.GetTokenOwner(user.trello_token);
      let boardsList = await trelloManager.GetUserBoards(owner.id);

      ctx.replyWithHTML(FormBoardsList(boardsList, user.lang, user));
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {Array.<Number>} trelloPendingConfirmationUsers 
 */
async function TrelloAuthenticate(ctx, db, trelloPendingConfirmationUsers) {
   let token = ctx.message.text;
   const replies = rp.LoadReplies(ctx.from.language_code);
   let match = token.match(/^([a-zA-Z0-9]){64}$/);
   if (match != null) {
      db.SetUserTrelloToken(ctx.from.id, token);
      trelloPendingConfirmationUsers.splice(trelloPendingConfirmationUsers.indexOf(ctx.from.id), 1);

      let trelloManager = new TrelloManager(process.env.TRELLO_KEY, token);
      let owner = await trelloManager.GetTokenOwner(token);
      let boardsList = await trelloManager.GetUserBoards(owner.id);

      let reply = `${replies.trelloValidToken}\r\n${FormBoardsList(boardsList, ctx.from.language_code, user)}`;

      ctx.replyWithHTML(reply);
   } else {
      ctx.replyWithHTML(replies.trelloWrongToken, rp.CancelButton(ctx.from.language_code));
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 */
async function TrelloAddBoard(ctx, db) {
   let text = ctx.message.text;
   let i = +text.substring(trelloAddBoardCommand.length) - 1;

   let user = await db.GetUserById(ctx.from.id);
   let trelloManager = new TrelloManager(process.env.TRELLO_KEY, user.trello_token);
   let owner = await trelloManager.GetTokenOwner(user.trello_token);
   let boardsList = await trelloManager.GetUserBoards(owner.id);

   let targetBoard = boardsList[i];
   let found = typeof (user.trello_boards.find(x => {
      return x == targetBoard.id;
   })) != 'undefined';
   if (found) {
      console.log(`removed board :>> ${JSON.stringify(await db.RemoveTrelloBoardFromUser(ctx.from.id, targetBoard.id))}`);
   } else {
      let result = await db.AddTrelloBoardToUser(ctx.from.id, targetBoard.id);
      if (result.rowCount == 0) {
         ctx.replyWithHTML(`${rp.LoadReplies(user.lang).trelloTooManyBoardsWarning} ${db.maximumAddedTrelloBoards}`);
         return;
      }
   }
   ctx.replyWithHTML(rp.ChangedBoard(user.lang, targetBoard, found));
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {User} user
 */
async function TrelloBindCommand(ctx, db, user) {
   const replies = rp.LoadReplies(user.lang);
   let text = ctx.message.text;
   let id = text.substring(trelloBindBoardCommand.length + 1);

   if (user.trello_boards.indexOf(id) >= 0) {
      let chat = await db.GetChatById(`${ctx.chat.id}`);
      let trelloManager = new TrelloManager(process.env.TRELLO_KEY, user.trello_token);
      let chatId = `${ctx.chat.id}`;
      if (typeof (chat) == 'undefined') {
         await db.AddChat(chatId, id);
      } else {
         await db.SetChatTrelloBoard(chatId, id);
      }
      let board = await trelloManager.GetBoard(id);
      ctx.replyWithHTML(FormBoardListsList(board, user.lang));
   } else {
      ctx.reply(replies.trelloBoardDoesNotExist);
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 */
async function TrelloAddList(ctx, db) {
   let text = ctx.message.text;
   let i = parseInt(text.substring(trelloAddListCommand.length)) - 1;

   let chatId = `${ctx.chat.id}`;
   let user = await db.GetUserById(ctx.from.id);
   const replies = rp.LoadReplies(user.lang);
   let chat = await db.GetChatById(chatId);
   if (chat.trello_board_id == null) {
      ctx.reply(replies.trelloNoBoardBinded);
      return;
   }
   let trelloManager = new TrelloManager(process.env.TRELLO_KEY, user.trello_token);
   let board = await trelloManager.GetBoard(chat.trello_board_id);
   let target_list = board.lists[i];
   await db.SetChatTrelloList(chatId, target_list.id, user.trello_token);
   ctx.replyWithHTML(FormListBinded(board, target_list, user.lang));
}

module.exports = {
   ClearPendingConfirmation,
   GetDeletingIDsIndex,
   FormatChatId,
   LoadSchedulesList,
   DeleteSchedules,
   StartTimeZoneDetermination,
   CheckExpiredSchedules,
   HandleCallbackQuery,
   HandleTextMessage,
   TrelloCommand,
   TrelloBindCommand
}