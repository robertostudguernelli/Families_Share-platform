const Excel = require('exceljs')
const Profile = require('../models/profile')
const Child = require('../models/child')
const Parent = require('../models/parent')
const moment = require('moment')

const syncChildSubscriptions = async participants => {
  const currentChildSuscriptions = [...new Set(participants[0].needs.reduce((a, b) => a.concat(b.children), []))]
  for (const childSubscription of currentChildSuscriptions) {
    const parent = await Parent.findOne({ child_id: childSubscription, parent_id: { $ne: participants[0].user_id } })
    participants.forEach((participant) => {
      if (parent && participant.user_id === parent.parent_id) {
        if (participant.needs.length > 0) {
          participant.needs.forEach(otherParentNeed => {
            if (otherParentNeed.children.includes(childSubscription)) {
              otherParentNeed.children.splice(otherParentNeed.children.indexOf(childSubscription), 1)
            }
          })
          participant.needs = participant.needs.filter(n => n.children.length > 0)
          participants[0].needs
            .filter(n => n.children.includes(childSubscription))
            .forEach(myNeed => {
              const needIndex = participant.needs.findIndex(n => moment(n.day).format('DDMMYY') === moment(myNeed.day).format('DDMMYY'))
              if (needIndex === -1) {
                participant.needs.push({
                  day: myNeed.day,
                  children: [childSubscription]
                })
              } else {
                participant.needs[needIndex].children.push(childSubscription)
              }
            })
          participant.needs = participant.needs.sort((a, b) => new Date(a) - new Date(b))
        }
      }
    })
  }
  return participants
}

const findOptimalSolution = async (plan) => {
  const { ratio, min_volunteers: minVolunteers, participants } = plan
  let people = []
  let slots = []
  // create array with people and array with slots
  participants.forEach(p => {
    people.push({ id: p.user_id, type: 'parent' })
    p.availabilities.forEach(a => slots.push(a.day.getTime()))
    p.needs.forEach(n => {
      slots.push(n.day.getTime())
      n.children.forEach(c => {
        people.push({ id: c, type: 'child' })
      })
    })
  })
  // remove duplicates from people and slots
  people = people.filter(
    (person, index, self) =>
      index === self.findIndex(obj => person.id === obj.id)
  )
  slots = [...new Set(slots)]
  // assign people to slots
  let subscriptions = slots.map(s =>
    people.map(p => {
      if (p.type === 'parent') {
        if (
          participants
            .find(pa => pa.user_id === p.id)
            .availabilities
            .map(a => a.day.getTime())
            .includes(s)
        ) {
          return 'p'
        }
        return '-'
      } else {
        for (const pa of participants) {
          for (const ne of pa.needs) {
            if (ne.day.getTime() === s && ne.children.includes(p.id)) {
              return 'c'
            }
          }
        }
        return '-'
      }
    })
  )
  console.log('subscriptions\n', subscriptions)
  // remove unnecessary slots
  subscriptions = subscriptions.filter((sub, index) => {
    if (sub.includes('c')) {
      return true
    } else {
      slots[index] = null
      return false
    }
  })
  slots = slots.filter(s => s !== null)
  console.log('filtered subscription\n', subscriptions)
  // find fullfilled
  const fullfilled = subscriptions.map(sub => {
    const totalParents = sub.filter(s => s === 'p').length
    const totalChildren = sub.filter(s => s === 'c').length
    if (totalParents >= minVolunteers && Math.ceil(totalChildren / totalParents) <= ratio) {
      return 1
    }
    return 0
  })
  console.log('fullfilled', fullfilled)
}

function newExportEmail (plan_name) {
  return `<div
  style="height:100%;display:table;margin-left:auto;margin-right:auto"
>
  <div style="width:300px">
    <img
      style="display:block;margin-left:auto;margin-right:auto"
      src="https://www.families-share.eu/uploads/images/families_share_logo.png"
    />
      <p style="margin:1rem 0;font-size:1.3rem;color:#565a5c;">
          You requested to export plan ${plan_name}. Attached to this email, you will find a xls containing the activity's information.
      </p>
    </div>
  </div>
</div>`
}

const createNeedsSheet = (workBook, parentProfiles, childrenProfiles, slots, people, plan) => {
  const needsSheet = workBook.addWorksheet('Children Needs')
  needsSheet.columns = [
    {
      key: 'child'
    },
    {
      key: 'parent'
    },
    ...slots.map(s => ({
      key: s
    }))
  ]
  let row = {
    child: ' ',
    parent: ' '
  }
  slots.forEach(s => {
    row[s] = moment(s).format('dddd')
  })
  needsSheet.addRow(row)
  row = {
    child: 'Child name',
    parent: 'Parent name'
  }
  slots.forEach(s => {
    row[s] = moment(s).format('DD/MM/YYYY')
  })
  const headersRow = needsSheet.addRow(row)
  headersRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEFEFEF' }
  }
  headersRow.height = 20
  headersRow.border = {
    bottom: { style: 'thick', color: { argb: 'FFDADFE9' } }
  }
  headersRow.font = { bold: true }

  needsSheet.getColumn('B').border = {
    right: { style: 'thick', color: { argb: 'FFDADFE9' } }
  }
  needsSheet.getCell('B2').border = {
    bottom: { style: 'thick', color: { argb: 'FFDADFE9' } },
    right: { style: 'thick', color: { argb: 'FFDADFE9' } }
  }
  people.filter(p => p.type === 'child').forEach(child => {
    const childProfile = childrenProfiles.find(c => c.child_id === child.id)
    const parentProfile = parentProfiles.find(p => p.user_id === child.parent)
    row = {
      child: childProfile.given_name,
      parent: `${parentProfile.given_name} ${parentProfile.family_name}`
    }
    slots.forEach(s => {
      row[s] = ''
      plan.participants.forEach(p => {
        const need = p.needs.find(n => moment(n.day).format('DD MMM YYYY') === s)
        if (need) {
          if (need.children.includes(child.id)) {
            row[s] = 'x'
          }
        }
      })
    })
    needsSheet.addRow(row)
  })
}

const createAvailabilitiesSheet = (workBook, parentProfiles, slots, people, plan) => {
  const availabilitiesSheet = workBook.addWorksheet('Parent Availabilities')
  let columns = [
    {
      key: 'parent'
    }
  ]
  slots.forEach((s, index) => {
    columns.push({
      key: `${s}-AM`
    })
    columns.push({
      key: `${s}-PM`
    })
    availabilitiesSheet.mergeCells(1, 2 * index + 2, 1, 2 * index + 3)
    availabilitiesSheet.mergeCells(2, 2 * index + 2, 2, 2 * index + 3)
  })
  const weekdaysRow = availabilitiesSheet.getRow(1)
  const datesRow = availabilitiesSheet.getRow(2)
  const meridiemRow = availabilitiesSheet.getRow(3)
  datesRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEFEFEF' }
  }
  datesRow.font = { bold: true }
  meridiemRow.font = datesRow.font
  meridiemRow.fill = datesRow.fill
  slots.forEach((s, index) => {
    weekdaysRow.getCell(index + 2).alignment = { horizontal: 'center' }
    datesRow.getCell(index + 2).alignment = { horizontal: 'center' }
    meridiemRow.getCell(index * 2 + 2).alignment = { horizontal: 'center' }
    meridiemRow.getCell(index * 2 + 3).alignment = { horizontal: 'center' }
    weekdaysRow.getCell(index + 2).value = moment(s).format('dddd')
    datesRow.getCell(index + 2).value = moment(s).format('DD/MM/YYYY')
    meridiemRow.getCell(index * 2 + 2).value = 'AM'
    meridiemRow.getCell(index * 2 + 3).value = 'PM'
  })
  // headersRow.height = 20
  // headersRow.border = {
  //   bottom: { style: 'thick', color: { argb: 'FFDADFE9' } }
  // }
  // headersRow.font = { bold: true }

  // needsSheet.getColumn('B').border = {
  //   right: { style: 'thick', color: { argb: 'FFDADFE9' } }
  // }
  // needsSheet.getCell('B2').border = {
  //   bottom: { style: 'thick', color: { argb: 'FFDADFE9' } },
  //   right: { style: 'thick', color: { argb: 'FFDADFE9' } }
  // }
  // people.filter(p => p.type === 'child').forEach(child => {
  //   const childProfile = childrenProfiles.find(c => c.child_id === child.id)
  //   const parentProfile = parentProfiles.find(p => p.user_id === child.parent)
  //   row = {
  //     child: childProfile.given_name,
  //     parent: `${parentProfile.given_name} ${parentProfile.family_name}`
  //   }
  //   slots.forEach(s => {
  //     row[s] = ''
  //     plan.participants.forEach(p => {
  //       const need = p.needs.find(n => moment(n.day).format('DD MMM YYYY') === s)
  //       if (need) {
  //         if (need.children.includes(child.id)) {
  //           row[s] = 'x'
  //         }
  //       }
  //     })
  //   })
  //   needsSheet.addRow(row)
  // })
}

async function createExcel (plan, cb) {
  const workBook = new Excel.Workbook()
  workBook.creator = 'Families Share'
  workBook.created = new Date()
  let people = []
  const start = moment(plan.start)
  const end = moment(plan.to)
  const slots = [start.format('DD MMM YYYY')]
  while (start.add(1, 'days').diff(end) <= 0) {
    slots.push(start.clone().format('DD MMM YYYY'))
  }
  slots.push(end.format('DD MMM YYYY'))
  plan.participants.forEach(p => {
    people.push({ id: p.user_id, type: 'parent' })
    p.needs.forEach(n => {
      n.children.forEach(c => {
        people.push({ id: c, type: 'child', parent: p.user_id })
      })
    })
  })
  people = people.filter(
    (person, index, self) =>
      index === self.findIndex(obj => person.id === obj.id)
  )
  const parentProfiles = await Profile.find({ user_id: { $in: people.filter(p => p.type === 'parent').map(p => p.id) } })
  const childrenProfiles = await Child.find({ child_id: { $in: people.filter(p => p.type === 'child').map(p => p.id) } })
  const planSheet = workBook.addWorksheet('Plan details')
  createNeedsSheet(workBook, parentProfiles, childrenProfiles, slots, people, plan)
  createAvailabilitiesSheet(workBook, parentProfiles, slots, people, plan)
  const slotsSheet = workBook.addWorksheet('Needs and Availabilities')
  const solutionSheet = workBook.addWorksheet('Optimal Timeslots Solution')
  planSheet.columns = [
    {
      key: 'name',
      header: 'Name'
    },
    {
      key: 'description',
      header: 'Description'
    },
    {
      key: 'category',
      header: 'Category'
    },
    {
      key: 'location',
      header: 'Location'
    },
    {
      key: 'from',
      header: 'From'
    },
    {
      key: 'to',
      header: 'To'
    },
    {
      key: 'deadline',
      header: 'Deadline'
    },
    {
      key: 'ratio',
      header: 'Children to Volunteers ratio'
    },
    {
      key: 'min_volunteers',
      header: 'Min number of volunteers'
    },
    {
      key: 'state',
      header: 'State'
    }
  ]
  slotsSheet.columns = [
    {
      key: 'name',
      header: ''
    },
    ...slots.map(s => ({
      key: s,
      header: s
    }))
  ]
  solutionSheet.columns = slotsSheet.columns
  people.forEach(person => {
    let profile
    if (person.type === 'parent') {
      profile = parentProfiles.find(p => p.user_id === person.id)
    } else {
      profile = childrenProfiles.find(p => p.child_id === person.id)
    }
    const row = { name: `${profile.given_name} ${profile.family_name}` }
    slots.forEach(slot => {
      let value = ''
      if (person.type === 'parent') {
        const availability = plan.participants
          .find(p => p.user_id === person.id)
          .availabilities
          .find(a => moment(a.day).format('DD MMM YYYY') === slot)
        if (availability) {
          value = availability.meridiem
        }
      } else {
        plan.participants.forEach(p => {
          const need = p.needs.find(n => moment(n.day).format('DD MMM YYYY') === slot)
          if (need) {
            if (need.children.includes(person.id)) {
              value = 'x'
            }
          }
        })
      }
      row[slot] = value
    })
    slotsSheet.addRow(row)
  })
  planSheet.addRow({
    name: plan.name,
    description: plan.description,
    location: plan.location,
    min_volunteers: plan.min_volunteers,
    ratio: plan.ratio,
    from: moment(plan.from).format('DD MMM YYYY'),
    to: moment(plan.to).format('DD MMM YYYY'),
    deadline: moment(plan.deadline).format('DD MMM YYYY'),
    category: plan.category,
    state: plan.state
  })
  if (plan.state === 'planning') {
    findOptimalSolution(plan)
  }
  workBook.xlsx.writeFile(`${plan.name.toUpperCase()}.xlsx`).then(() => {
    cb()
  })
}

module.exports = {
  findOptimalSolution,
  newExportEmail,
  createExcel,
  syncChildSubscriptions
}
