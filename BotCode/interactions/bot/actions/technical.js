const Markup = require('telegraf/markup');
const { Languages, LoadReplies } = require('../static/replies/repliesLoader');
const Format = require('../../processing/formatting');
const kbs = require('../static/replies/keyboards');
const { DataBase, Schedule, User, Chat } = require('../../../storage/dataBase/DataBase');
const { BotReply } = require('./replying');
const utils = require('../../processing/utilities');
const { ScheduleStates } = require('../../../storage/dataBase/TablesClasses/Schedule');

/**
 * @param {String} chatID 
 * @param {Number} tsOffset 
 * @param {Languages} language
 * @returns {Array.<String>}
 */
async function LoadSchedulesList(chatID, tsOffset, language) {
   let schedules = await DataBase.Schedules.ListSchedules(chatID);
   if (schedules.length > 0) {
      let answers = [];
      let answer = ``;
      schedules.sort((a, b) => a.target_date - b.target_date);
      for (let schedule of schedules) {
         let newAnswer = `${await Format.FormStringFormatSchedule(schedule, tsOffset, language, false, true)}\r\n`;
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
 * @param {Languages} 
 */
async function DeleteSchedules(ctx) {
   let chatID = utils.FormatChatId(ctx.chat.id)
   let msgText = ctx.message.text;
   const replies = LoadReplies(ctx.from.language_code);
   if (msgText.indexOf('all') == "/del ".length) {
      await DataBase.Schedules.ClearAllSchedules(chatID);
      BotReply(ctx, replies.cleared);
      return;
   }
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
         let scheduleNum = nums[i];
         query += `num = ${scheduleNum} OR `;
      }
      query = query.substring(0, query.length - 4);
      await DataBase.Schedules.RemoveSchedulesQuery(chatID, query);
      await DataBase.Schedules.ReorderSchedules(chatID);
      let end = '';
      if (nums.length > 1) {
         end = 's';
      }
      try {
         BotReply(ctx, Format.Deleted(nums.join(', '), false, ctx.message.from.language_code));
      } catch (e) {
         console.error(e);
      }
      return;
   }
   try {
      BotReply(ctx, replies.invalidUseOfCommand);
   } catch (e) {
      console.error(e);
   }
}

/**
 * @param {*} ctx 
 * @param {Array.<Number>} tzPendingConfirmationUsers 
 */
async function StartTimeZoneDetermination(ctx, tzPendingConfirmationUsers) {
   let curTZ = (await DataBase.Users.GetUserById(ctx.from.id, true)).tz;
   let reply = '';
   const language = await DataBase.Users.GetUserLanguage(ctx.from.id);
   const replies = LoadReplies(language);
   if (curTZ != null) {
      reply = replies.tzDefined + '<b>' + Format.TzCurrent(curTZ) + '</b>\r\n';
   }
   let isPrivateChat = ctx.chat.id >= 0;
   if (isPrivateChat) {
      reply += replies.tzConfiguration + '\r\n' + replies.tzViaLoc + '\r\n' + replies.tzManually;
      try {
         return await BotReply(ctx, reply, kbs.TzDeterminationKeyboard(language));
      } catch (e) {
         console.error(e);
      }
   }
   if (tzPendingConfirmationUsers.indexOf(ctx.from.id) < 0) {
      tzPendingConfirmationUsers.push(ctx.from.id);
   }
   try {
      return await BotReply(ctx, replies.tzGroupChatConfiguration);
   } catch (e) {
      console.error(e);
   }
}

/**
 * @param {*} ctx 
 * @param {Array.<Number>} tzPendingConfirmationUsers 
 */
async function ConfrimTimeZone(ctx, tzPendingConfirmationUsers) {
   let userId = ctx.from.id;
   let matches = ctx.message.text.match(/(\+|-|???|???|)([0-9])+:([0-9])+/g);
   let hours, minutes, negative, ts;
   const replies = LoadReplies(ctx.from.language_code);
   if (matches != null) {
      //Parse tz from msg;
      let offset = matches[0];
      let index = offset.indexOf(':');
      hours = parseInt(offset.substring(0, index));
      negative = offset[0].match(/-|???|???/g) != null;
      minutes = parseInt(offset.substring(index + 1));
      console.log(`Determining tz: offset = ${offset}, hours = ${hours}, minutes = ${minutes}, ts = ${ts}`);
   } else {
      matches = ctx.message.text.match(/(\+|-|???|???|)([0-9])+/g);
      if (matches != null) {
         let offset = matches[0];
         hours = parseInt(offset);
         minutes = 0;
         negative = offset[0].match(/-|???|???/g) != null;
         console.log(`Determining tz from only hour option: offset = ${offset}, hours = ${hours}, minutes = ${minutes}, ts = ${ts}`);
      }
   }
   if (matches != null) {
      let ts = hours * 3600;
      ts += minutes * 60 * (negative ? -1 : 1);
      if (!await DataBase.Users.HasUserID(userId)) {
         await DataBase.Users.AddUser(new User(userId, ts, global.defaultUserLanguage));
      } else {
         await DataBase.Users.SetUserTz(userId, ts);
      }
      tzPendingConfirmationUsers.splice(tzPendingConfirmationUsers.indexOf(ctx.from.id), 1);
      try {
         let chatID = utils.FormatChatId(ctx.chat.id);
         BotReply(ctx, replies.tzDefined + '<b>' + Format.TzCurrent(ts) + '</b>\r\n', await kbs.LogicalListKeyboard(ctx.from.language_code, chatID));
      } catch (e) {
         console.error(e);
      }
   } else {
      console.log(`Can't determine tz in "${ctx.message.text}"`);
      try {
         BotReply(ctx, replies.tzInvalidInput, kbs.CancelButton(ctx.from.language_code));
      } catch (e) {
         console.error(e);
      }
   }
}

async function StartDisplayingStatus(ctx) {
   if (ctx.from.id != +process.env.SMART_SCHEDULER_ADMIN) {
      return;
   }
   let channelInfo;
   let text = ctx.message.text;
   let index = text.indexOf(' ');
   let option;
   if (index == -1) {
      channelInfo = ctx.from;
      option = kbs.CancelButton(ctx.from.language_code);
   } else {
      let channelId = text.substring(index + 1);
      try {
         channelInfo = await ctx.telegram.getChat(channelId);
      } catch (e) {
         console.log(e);
         return;
      }
   }
   let usersCount = await DataBase.Users.GetSubscribedUsersCount();
   let schedulesCount = await DataBase.Schedules.GetTotalSchedulesCount();
   text = Format.FormDisplayStatus(ctx.from.language_code, usersCount, schedulesCount);
   let msg = await BotReply(ctx, text, option, undefined, channelInfo.id);
   let schedule = new Schedule(utils.FormatChatId(channelInfo.id), -1, ctx.from.language_code, 'none', -1, -1, -1, undefined, ScheduleStates.statusDisplay, msg.message_id);
   await DataBase.Schedules.AddSchedule(schedule);
}

module.exports = {
   LoadSchedulesList,
   DeleteSchedules,
   StartTimeZoneDetermination,
   ConfrimTimeZone,
   StartDisplayingStatus
}