import { TUS_EXAM_OFFICIAL_URL, examProgrammeChoices, examsForProgramme, examSourceFreshness } from "./exams-utils.js";

const esc=value=>String(value??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const dateLabel=date=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||"")))return date||"";
  return new Intl.DateTimeFormat("en-IE",{weekday:"long",day:"numeric",month:"short",year:"numeric"})
    .format(new Date(date+"T12:00:00"));
};
const officialLink=()=>'<a class="exam-official-link" href="'+TUS_EXAM_OFFICIAL_URL+
  '" target="_blank" rel="noopener noreferrer">Check latest official TUS exam timetable ↗</a>';

export function examSourceCaution(data){
  const f=examSourceFreshness(data);
  return '<div class="exam-source-status '+(f.fresh?'':'exam-source-stale')+'">'+
    esc(f.label)+'. Dates, rooms and times may change. Verify with TUS before your exam. '+
    officialLink()+'</div>';
}
export function examCard(exam,compact=false){
  return '<article class="exam-card '+(compact?'exam-card-compact':'')+'">'+
    '<div class="exam-date">'+esc(dateLabel(exam.date))+' · '+esc(exam.start)+'–'+esc(exam.end)+'</div>'+
    '<strong>'+esc(exam.module)+'</strong>'+
    '<div class="exam-room">Venue: '+esc(exam.room)+'</div>'+
    '<small>'+esc(exam.module_code)+(exam.note?' · '+esc(exam.note):'')+'</small>'+
    '</article>';
}
export function examWeekSummary(data,code,week){
  if(!data||!code||!week?.week_start||!week?.week_end)return '';
  const items=examsForProgramme(data,code).filter(e=>e.date>=week.week_start&&e.date<=week.week_end);
  if(!items.length)return '';
  return '<section class="exam-week-summary"><h3>Exams this week</h3>'+
    '<p>Programme exam slots, not confirmed personal registrations. Check enrolled modules and the official TUS timetable.</p>'+
    '<div class="exam-week-list">'+items.map(e=>examCard(e,true)).join('')+'</div>'+
    examSourceCaution(data)+'</section>';
}
export function renderExamPage(data,code,sourceError){
  if(!data)return '<section class="exams-view"><div class="empty">'+
    (sourceError?'Exam source unavailable. Use TUS official timetable.':'Checking official TUS exam timetables…')+
    '</div>'+officialLink()+'</section>';
  const choices=examProgrammeChoices(data),current=data.programmes?.[code];
  const selector='<label class="exam-course-label" for="exam-programme">Programme code</label>'+
    '<select id="exam-programme"><option value="">Choose exact TUS programme</option>'+
    choices.map(p=>'<option value="'+esc(p.code)+'" '+(p.code===code?'selected':'')+'>'+
      esc(p.code)+' · '+esc(p.name)+'</option>').join('')+'</select>';
  const cardList=!current
    ?'<div class="empty">The timetable group could not be matched to a programme code automatically. Select the correct programme above; do not select based on a module name alone.</div>'
    :'<h2>'+esc(current.name)+'</h2><p class="exam-code">'+esc(code)+'</p>'+
      '<div class="exam-list">'+examsForProgramme(data,code).map(e=>examCard(e)).join('')+'</div>'+
      '<p class="exam-advice">This programme list may include optional modules. Only exams for modules you are registered to take apply to you. Continuous assessment modules might not appear here.</p>';
  return '<section class="exams-view">'+selector+cardList+examSourceCaution(data)+'</section>';
}
