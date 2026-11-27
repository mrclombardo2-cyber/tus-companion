import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { examProgrammeForSelection, examsForProgramme, examsForDate, examSourceFreshness } from "../frontend/exams-utils.js";
import { renderExamPage, examWeekSummary } from "../frontend/exams-view.js";

const sample={
  schema:1,last_checked_at:new Date().toISOString(),
  sources:[{filename:"Bus-Mgt_S1_TT_2026_V3b.xls",url:"https://tus.ie/app/uploads/AcademicServices/Exams/Midlands/FacultyBusinessandHospitality/Bus-Mgt_S1_TT_2026_V3b.xls"}],
  programmes:{
    AL_BBSTD_C_2:{name:"Higher Certificate in Business in Business",exams:[
      {module:"Management Accounting",module_code:"ACCT 06004 S1",date:"2026-12-09",start:"09:00",end:"12:00",room:"B53-B58",source:"Bus-Mgt"},
      {module:"Business Law",module_code:"LAW 06059 S1",date:"2026-12-17",start:"09:00",end:"11:00",room:"Arena",source:"Bus-Mgt"}
    ]},
    AL_BBSTD_7_2:{name:"Bachelor of Business in Business",exams:[
      {module:"Business Law",module_code:"LAW 06059 S1",date:"2026-12-17",start:"09:00",end:"11:00",room:"Arena",source:"Bus-Mgt"}
    ]}
  }
};

test("matches the exact TUS programme code, not the generic subject or similar code",()=>{
  assert.equal(examProgrammeForSelection({group:"AL_BBSTD_C_2 B"},sample),"AL_BBSTD_C_2");
  assert.equal(examProgrammeForSelection({group:"AL_BBSTD_7_2 A"},sample),"AL_BBSTD_7_2");
  assert.equal(examProgrammeForSelection({group:"AL_BBSTD_C_21"},sample),null);
  assert.equal(examProgrammeForSelection({group:"g1",groupLabel:"Business Law"},sample),null);
  assert.equal(examProgrammeForSelection({group:"g1",groupLabel:"AL_BBSTD_C_2 B - Business"},sample),"AL_BBSTD_C_2");
  assert.equal(examProgrammeForSelection({group:"AL_BBLAW_8_2"},sample),null);
});

test("exams are programme-specific and week/date filtered",()=>{
  assert.equal(examsForProgramme(sample,"AL_BBSTD_C_2").length,2);
  assert.equal(examsForProgramme(sample,"AL_BBSTD_7_2").length,1);
  assert.equal(examsForProgramme(sample,"AL_BBLAW_8_2").length,0);
  assert.equal(examsForDate(sample,"AL_BBSTD_C_2","2026-12-09")[0].module,"Management Accounting");
  assert.equal(examsForDate(sample,"AL_BBSTD_C_2","2026-12-10").length,0);
  const w={week_start:"2026-12-07",week_end:"2026-12-13"};
  const html=examWeekSummary(sample,"AL_BBSTD_C_2",w);
  assert.match(html,/Management Accounting/);
  assert.match(html,/B53-B58/);
  assert.doesNotMatch(html,/Business Law/);
  assert.equal(examWeekSummary(sample,"AL_BBLAW_8_2",w),"");
});

test("exam cards clearly label programme schedules as non-personal and link official source",()=>{
  const html=renderExamPage(sample,"AL_BBSTD_C_2",false);
  assert.match(html,/Higher Certificate in Business/);
  assert.match(html,/Wednesday, 9 Dec 2026/);
  assert.match(html,/Thursday, 17 Dec 2026/);
  assert.match(html,/registered to take/);
  assert.match(html,/tus\.ie\/exams\/midlands\/timetables/);
  assert.doesNotMatch(renderExamPage(sample,null,false),/exam-list/);
});

test("stale or missing source check is visible instead of being presented as live exam data",()=>{
  assert.equal(examSourceFreshness(sample).fresh,true);
  assert.equal(examSourceFreshness({...sample,last_checked_at:"2026-01-01T00:00:00Z"}).fresh,false);
  assert.equal(examSourceFreshness({...sample,last_checked_at:null}).fresh,false);
  assert.match(renderExamPage(null,null,true),/source unavailable/i);
});

test("official exam refresh is configured to fail closed and never take passwords",()=>{
  const code=readFileSync(new URL("../scripts/build_exam_data.py",import.meta.url),"utf8");
  const deploy=readFileSync(new URL("../.github/workflows/deploy-cloudflare.yml",import.meta.url),"utf8");
  assert.match(code,/https:\/\/tus\.ie\/exams\/midlands\/timetables\/business-and-hospitality\//);
  assert.match(code,/sha256\(raw\)/);
  assert.match(code,/Unknown programme code/);
  assert.match(code,/Exam day\/date mismatch/);
  assert.match(deploy,/scripts\/build_exam_data\.py --output frontend\/exam-data\.json/);
  assert.match(deploy,/Official exam source unavailable/);
  assert.match(deploy,/17 7,17 \* 11,12 \*/);
});
