// Mesma URL/papel chat_fn da chat; somente RPCs parametrizadas da 013.
import postgres from 'npm:postgres@3.4.9'
import type { TelegramDb } from './telegram_db.ts'
export function createPgTelegramDb(url: string): TelegramDb {
  const sql = postgres(url,{max:1,prepare:false,ssl:'require',connect_timeout:10,idle_timeout:20,connection:{application_name:'atlas_telegram_fn'}})
  const value = async (q: PromiseLike<{v?:unknown}[]>) => (await q)[0]?.v
  return {
    async issueCode(u,h,iat) { return await value(sql`select chat_private.telegram_issue_code(${u}::uuid,${h},${iat}::bigint) as v`)===true },
    async revokeCodes(u) { await sql`select chat_private.telegram_revoke_codes(${u}::uuid)` },
    async consumeCode(t,h) { return await value(sql`select chat_private.telegram_consume_code(${t}::bigint,${h}) as v`)===true },
    async unlink(t) { await sql`select chat_private.telegram_unlink(${t}::bigint)` },
    async linkedUser(t) { const u=await value(sql`select chat_private.telegram_linked_user(${t}::bigint) as v`);return typeof u==='string'?u:null },
    async claimUpdate(i) { return await value(sql`select chat_private.telegram_claim_update(${i}::bigint) as v`)===true },
    async rateTouch(t) { return await value(sql`select chat_private.telegram_rate_touch(${t}::bigint) as v`)===true },
    async beginSession(h,t,p,e) { return await value(sql`select chat_private.telegram_begin_session(${h},${t}::bigint,${p},${e}::bigint) as v`)===true },
    async sessionUser(h,t,p) {
      const raw=await value(sql`select chat_private.telegram_session_user(${h},${t}::bigint,${p}) as v`)
      const row=(typeof raw==='string'?JSON.parse(raw):raw) as {ok?:unknown;user_id?:unknown}|null
      return {ok:row?.ok===true,userId:typeof row?.user_id==='string'?row.user_id:null}
    },
  }
}
