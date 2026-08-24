// Which of the ten is drawn.
//
// Each swatch is the REAL pet, drawn by the same walk over the same art the sprite uses -
// so a swatch cannot be out of date with what pressing it does, the way a picture of a
// robot beside a robot eventually is. It is drawn STILL: the picker is a list of ten and
// ten looping sprites in a settings dialog is the animation budget spent on a decision
// that takes two seconds.

import { GRID, NO_PET, PETS, runsOf, type Pet } from '@shared/pets'

/** The still pose: the body, both fixed extras, and whichever eye position looks ahead. */
function still(pet: Pet): string[][] {
  const a = pet.art
  return [
    ...(a.arms ? [a.arms.a] : []),
    ...(a.treads ? [a.treads.a] : []),
    a.body,
    ...(a.antenna ? [a.antenna.mast] : []),
    ...(a.beacon ? [a.beacon.on] : []),
    ...(a.eyes ? [a.eyes.ahead] : [])
  ]
}

interface Props {
  value: string
  onChange: (id: string) => void
}

export default function PetPicker({ value, onChange }: Props): JSX.Element {
  return (
    <div className="pet-grid">
      {/* No animal, and every reading kept. It sits in the picker rather than beside the
          on/off switch because it IS the same choice - which pet - and because the switch
          next to it turns off the ladder's only voice, which is a different thing to want. */}
      <button
        className={'pet-swatch' + (value === NO_PET ? ' on' : '')}
        title="No pet - the readings dock in the corner instead"
        onClick={() => onChange(NO_PET)}
      >
        <svg viewBox={`0 0 ${GRID} ${GRID}`} width="38" height="38" aria-hidden="true">
          <rect
            className="pet-none-box"
            x="4.5"
            y="7.5"
            width="15"
            height="10"
            rx="2.5"
            fill="none"
            strokeWidth="1.4"
          />
          <rect className="pet-none-line" x="7" y="10.5" width="10" height="1.4" rx="0.7" />
          <rect className="pet-none-line" x="7" y="13.5" width="6.5" height="1.4" rx="0.7" />
        </svg>
        <span className="pet-name">None</span>
      </button>
      {PETS.map((pet) => (
        <button
          key={pet.id}
          className={'pet-swatch' + (value === pet.id ? ' on' : '')}
          title={pet.note}
          onClick={() => onChange(pet.id)}
        >
          <svg viewBox={`0 0 ${GRID} ${GRID}`} width="38" height="38" shapeRendering="crispEdges" aria-hidden="true">
            {still(pet).map((layer, li) =>
              runsOf(layer).map((r, i) => (
                <rect key={`${li}:${i}`} className={r.cls} x={r.x} y={r.y} width={r.w} height={1} />
              ))
            )}
          </svg>
          <span className="pet-name">{pet.name}</span>
        </button>
      ))}
    </div>
  )
}
