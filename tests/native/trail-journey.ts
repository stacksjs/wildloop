import type { SimulatorStep } from '@stacksjs/mobile/testing'

/** Real native UI interactions against the isolated QA database. */
export function nativeTrailJourneys(input:{trailId:number,trailName:string,email:string,password:string,review:string,edit:string}):{name:string,steps:SimulatorStep[],completion:string}[] {
const arrival:SimulatorStep[] = [
 // An account is required to use the app: a fresh install opens on the
 // gate, a relaunch with a kept session on the feed. Either way the login
 // link is the door to the trail, so the journey goes straight to it.
 {command:'launch'},
 {command:'openurl',url:`wildloop://login?next=/trail/${input.trailId}`},
 {command:'expectid',text:'login-email',seconds:10},
 {command:'typeid',id:'login-email',text:input.email},
 {command:'typeid',id:'login-password',text:input.password},
 {command:'shot',name:'native-login-filled'},
 {command:'tree',name:'native-login-filled'},
 {command:'tapid',text:'login-submit'},
 {command:'shot',name:'native-login-result'},
 {command:'tree',name:'native-login-result'},
 {command:'expect',text:input.trailName,seconds:30},
 {command:'shot',name:'native-trail-arrival'},
 {command:'tree',name:'native-trail-arrival'},
 {command:'expectid',text:'trail-native-map',seconds:15},
 {command:'shot',name:'native-trail-overview'},
 {command:'tree',name:'native-trail-overview'},
]
const maps:SimulatorStep[] = [
 ...arrival,
 {command:'expectexact',text:'Save',seconds:30},
 {command:'tapid',text:'trail-save'},
 {command:'expect',text:'Saved',seconds:10},
 {command:'tapid',text:'trail-save'},
 {command:'expectexact',text:'Save',seconds:10},
 {command:'scrollto',text:'Toggle elevation profile'},
 {command:'shot',name:'native-floating-profile-inline'},
 {command:'tapid',text:'trail-profile-toggle'},
 {command:'expect',text:'Elevation profile collapsed',seconds:10},
 {command:'scrollto',text:'Toggle elevation profile'},
 {command:'shot',name:'native-profile-collapsed-inline'},
 {command:'tapid',text:'trail-profile-toggle'},
 {command:'expect',text:'Elevation profile expanded',seconds:10},
 {command:'scrollto',text:'Expand map'},
 {command:'tapid',text:'trail-map-fullscreen'},
 {command:'expectid',text:'trail-full-map',seconds:10},
 {command:'shot',name:'native-floating-profile-fullscreen'},
 {command:'tree',name:'native-floating-profile-fullscreen'},
 {command:'tapid',text:'map-zoom-in'},
 {command:'tapid',text:'map-zoom-out'},
 {command:'tapid',text:'map-fit'},
 {command:'tapid',text:'map-3d'},
 {command:'expectexact',text:'2D',seconds:10},
 {command:'tapid',text:'map-north'},
 {command:'tapid',text:'map-profile-toggle'},
 {command:'expect',text:'Elevation profile collapsed',seconds:10},
 {command:'shot',name:'native-profile-collapsed'},
 {command:'tapid',text:'map-profile-toggle'},
 {command:'tapid',text:'map-layer'},
 {command:'tree',name:'native-layer-picker'},
 {command:'tapexact',text:'Satellite'},
 {command:'expect',text:'Map layer: Satellite',seconds:10},
 {command:'tree',name:'native-satellite'},
 {command:'shot',name:'native-satellite'},
 ...['Hybrid','Street','Outdoors'].flatMap((layer):SimulatorStep[]=>[
  {command:'tapid',text:'map-layer'},
  {command:'tapexact',text:layer},
  {command:'expect',text:`Map layer: ${layer}`,seconds:10},
 ]),
 {command:'back'},
 {command:'expectid',text:'trail-sticky-actions',seconds:10},
]
const reviews:SimulatorStep[] = [
 ...arrival,
 {command:'scrollto',text:'Leave a review'},
 {command:'tapid',text:'trail-write-review'},
 {command:'expectid',text:'trail-review-composer',seconds:10},
 {command:'tapid',text:'trail-review-star-5'},
 {command:'typeid',id:'trail-review-content',text:input.review},
 {command:'scrollto',text:'Save review'},
 {command:'tapid',text:'trail-review-submit'},
 {command:'expect',text:'Edit your review',seconds:15},
 {command:'expect',text:input.review,seconds:10},
 {command:'scrollto',text:'Edit your review'},
 {command:'shot',name:'native-review-created'},
 {command:'tree',name:'native-review-created'},
 {command:'tapid',text:'trail-write-review'},
 {command:'expectid',text:'trail-review-composer',seconds:10},
 {command:'typeid',id:'trail-review-content',text:input.edit},
 {command:'scrollto',text:'Save review'},
 {command:'tapid',text:'trail-review-submit'},
 {command:'expect',text:input.edit.trim(),seconds:15},
 {command:'shot',name:'native-review-edited'},
]
// Keep deletion observable even when editing fails earlier in its own phase.
// This removes the real review created above; the aggregate still fails if
// any part of the lifecycle fails.
const reviewDelete:SimulatorStep[] = [
 ...arrival,
 {command:'expect',text:input.review,seconds:15},
 {command:'scrollto',text:'Delete your review'},
 {command:'tapid',text:'trail-delete-review'},
 {command:'tapexact',text:'Delete review'},
 {command:'expect',text:'Leave a review',seconds:15},
 {command:'absent',text:input.review},
 {command:'shot',name:'native-review-deleted'},
 {command:'tree',name:'native-review-deleted'},
]
const fullMap:SimulatorStep[] = [
 ...arrival,
 {command:'openurl',url:`wildloop://trail/${input.trailId}/map`},
 {command:'expectid',text:'trail-full-map',seconds:15},
]
const sharing:SimulatorStep[] = [
 ...arrival,
 {command:'tapid',text:'trail-share'},
 {command:'expectexact',text:'Copy',seconds:10},
 {command:'shot',name:'native-share-sheet'},
 {command:'tree',name:'native-share-sheet'},
 {command:'tapexact',text:'Copy'},
 {command:'exec',name:'verify-share'},
]
const gpx:SimulatorStep[] = [
 ...fullMap,
 {command:'tapid',text:'map-export'},
 {command:'expectexact',text:'Copy',seconds:10},
 {command:'shot',name:'native-gpx-share-sheet'},
 {command:'tree',name:'native-gpx-share-sheet'},
 {command:'tapexact',text:'Copy'},
 {command:'exec',name:'verify-gpx'},
]
const planner:SimulatorStep[] = [
 ...fullMap,
 {command:'tapid',text:'map-customize'},
 {command:'expectid',text:'route-builder-map',seconds:15},
 {command:'expect',text:input.trailName,seconds:15},
 {command:'shot',name:'native-customize-route'},
 {command:'tree',name:'native-customize-route'},
 {command:'back'},
 {command:'expectid',text:'trail-full-map',seconds:10},
]
const location:SimulatorStep[] = [
 ...fullMap,
 {command:'exec',name:'seed-location'},
 {command:'tapid',text:'map-locate'},
 {command:'systemexpect',text:'Allow Once',seconds:10},
 {command:'systemtap',text:'Allow Once'},
 {command:'expect',text:'Your location is shown',seconds:20},
 {command:'tree',name:'native-location'},
 {command:'shot',name:'native-location'},
]
// The round button beside the tab pill: every trail around you on a map,
// with search, opened from the app's shared chrome (functions/native-chrome).
const explore:SimulatorStep[] = [
 // Before launch: changing a permission ends a running app.
 {command:'exec',name:'reset-location'},
 {command:'exec',name:'seed-location'},
 ...arrival,
 {command:'tapid',text:'craft-tab-accessory'},
 {command:'expectid',text:'explore-map',seconds:15},
 // The map asks where you are, and shows trails meanwhile.
 {command:'systemexpect',text:'Allow Once',seconds:10},
 {command:'systemtap',text:'Allow Once'},
 {command:'expect',text:'on the map',seconds:20},
 {command:'shot',name:'native-explore'},
 {command:'tree',name:'native-explore'},
 // A pin shows its trail's card, and the card opens the trail.
 {command:'tapid',text:`trail-${input.trailId}`},
 {command:'expectid',text:'explore-card',seconds:10},
 {command:'shot',name:'native-explore-card'},
 {command:'tapid',text:'explore-open'},
 {command:'expectid',text:'trail-native-map',seconds:15},
 // The map is a link of its own too.
 {command:'openurl',url:'wildloop://explore'},
 {command:'expectid',text:'explore-map',seconds:15},
 {command:'typeid',id:'explore-search',text:input.trailName},
 {command:'tapid',text:'explore-submit'},
 {command:'expect',text:'1 trail on the map',seconds:20},
 {command:'shot',name:'native-explore-search'},
 {command:'tree',name:'native-explore-search'},
]
return [
 {name:'maps',steps:maps,completion:'PASS expectid trail-sticky-actions'},
 {name:'explore',steps:explore,completion:'PASS expect 1 trail on the map'},
 {name:'reviews',steps:reviews,completion:`PASS expect ${input.edit.trim()}`},
 {name:'review-delete',steps:reviewDelete,completion:`PASS absent ${input.review}`},
 {name:'sharing',steps:sharing,completion:'exec verify-share: PASS native share copied the trail link'},
 {name:'gpx',steps:gpx,completion:'exec verify-gpx: PASS exported GPX contains the recorded route'},
 {name:'planner',steps:planner,completion:'PASS expectid trail-full-map'},
 {name:'location',steps:location,completion:'PASS expect Your location is shown'},
]
}
