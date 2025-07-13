const equipmentSymbols = [
   {
  name: "PRT",
  svg: `<circle cx="25" cy="20" r="15" stroke="black" stroke-width="2" fill="none"/>
        <circle cx="25" cy="35" r="10" stroke="black" stroke-width="2" fill="none"/>
        <line x1="25" y1="5" x2="25" y2="0" stroke="black" stroke-width="2"/>
        <line x1="25" y1="45" x2="25" y2="50" stroke="black" stroke-width="2"/>`
},
    {
  name: "VCB",
  svg: `<line x1="25" y1="0" x2="25" y2="10" stroke="black" stroke-width="2"/>
        <line x1="25" y1="40" x2="25" y2="50" stroke="black" stroke-width="2"/>
        <rect x="15" y="10" width="20" height="30" stroke="black" stroke-width="2" fill="none"/>
        <line x1="25" y1="10" x2="25" y2="20" stroke="black" stroke-width="2"/>
        <line x1="25" y1="30" x2="25" y2="40" stroke="black" stroke-width="2"/>
        <line x1="25" y1="20" x2="25" y2="30" stroke="red" stroke-width="3" id="movingContact"/>`
},
{
  name: "CT (1)",
  svg: `<line x1="0" y1="25" x2="50" y2="25" stroke="black" stroke-width="2"/>
        <path d="M 20 25 A 5 5 0 1 1 30 25 M 20 25 A 5 5 0 1 0 30 25" stroke="red" stroke-width="2" fill="none"/>
        <line x1="20" y1="25" x2="20" y2="40" stroke="black" stroke-width="2"/>
        <line x1="30" y1="25" x2="30" y2="40" stroke="black" stroke-width="2"/>
        <circle cx="20" cy="40" r="2" stroke="black" stroke-width="1.5" fill="none"/>
        <circle cx="30" cy="40" r="2" stroke="black" stroke-width="1.5" fill="none"/>`
},

{
  name: "CT (2)",
  svg: `
    <!-- Outer CT core -->
    <circle cx="25" cy="25" r="15" stroke="black" stroke-width="2" fill="none"/>
    
    <!-- Primary winding line -->
    <line x1="0" y1="25" x2="50" y2="25" stroke="black" stroke-width="2"/>
    
    <!-- Secondary terminals -->
    <line x1="20" y1="40" x2="20" y2="48" stroke="black" stroke-width="2"/>
    <line x1="30" y1="40" x2="30" y2="48" stroke="black" stroke-width="2"/>
    <circle cx="20" cy="48" r="2" stroke="black" stroke-width="1.5" fill="none"/>
    <circle cx="30" cy="48" r="2" stroke="black" stroke-width="1.5" fill="none"/>

  `
},
    {
        name: "Isolator",
  svg: `<line x1="25" y1="0" x2="25" y2="15" stroke="black" stroke-width="2"/>
        <line x1="25" y1="35" x2="25" y2="50" stroke="black" stroke-width="2"/>
        <line x1="15" y1="35" x2="35" y2="15" stroke="black" stroke-width="2" id="isolatorArm" transform-origin="25 25"/>
        <circle cx="25" cy="25" r="3" fill="black"/>`
    },


{
  name: "PT",
  svg: `
    <!-- Transformer Body -->
    <rect x="15" y="10" width="20" height="30" stroke="black" stroke-width="2" fill="none"/>

    <!-- Single Primary terminal -->
    <line x1="25" y1="0" x2="25" y2="10" stroke="black" stroke-width="2"/>
    <circle cx="25" cy="0" r="2" fill="black"/>

    <!-- Smooth, large-radius centered winding -->
    <path d="M17 18 Q25 20 17 22 Q25 24 17 26 Q25 28 17 30 Q25 32 17 34" stroke="black" stroke-width="1.5" fill="none"/>
    <path d="M33 18 Q25 20 33 22 Q25 24 33 26 Q25 28 33 30 Q25 32 33 34" stroke="black" stroke-width="1.5" fill="none"/>
  `
},

   {
        name: "Bus Junction", // New symbol for a full plus sign junction
        // Updated stroke color to #1f2937 and stroke-width to 2 to match connection lines
        svg: `<line x1="0" y1="25" x2="50" y2="25" stroke="#1f2937" stroke-width="2"/>
              <line x1="25" y1="0" x2="25" y2="50" stroke="#1f2937" stroke-width="2"/>`
    },


    {
  name: "DTR (1)",
  svg: `
    <!-- Outer circle to enclose the transformer -->
    <circle cx="25" cy="25" r="24" fill="none" stroke="black" stroke-width="2"/>

    <!-- Transformer symbol inside -->
    <circle cx="25" cy="18" r="10" stroke="black" stroke-width="2" fill="none"/>
    <circle cx="25" cy="32" r="8" stroke="black" stroke-width="2" fill="none"/>
    <line x1="25" y1="5" x2="25" y2="0" stroke="black" stroke-width="2"/>
    <line x1="25" y1="42" x2="25" y2="50" stroke="black" stroke-width="2"/>
  `
},

{
  name: "DTR (2)",
  svg: `
    <!-- Outer circle -->
    <circle cx="25" cy="25" r="24" fill="none" stroke="black" stroke-width="2"/>

    <!-- Primary coil (top) - reversed direction, centered -->
    <path d="M10 15 
             a5 6 0 0 0 10 0 
             a5 6 0 0 0 10 0 
             a5 6 0 0 0 10 0" 
          fill="none" stroke="black" stroke-width="1.5"/>

    <!-- Separator horizontal line -->
    <line x1="10" y1="25" x2="40" y2="25" stroke="black" stroke-width="1.5"/>

    <!-- Secondary coil (bottom) - normal direction, centered -->
    <path d="M10 35 
             a5 6 0 0 1 10 0 
             a5 6 0 0 1 10 0 
             a5 6 0 0 1 10 0" 
          fill="none" stroke="black" stroke-width="1.5"/>
  `
},
    {
  name: "Pole (1)",
  svg: `<circle cx="25" cy="25" r="25" fill="black" stroke="black" stroke-width="2"/>`
},
    {
  name: "Pole (2)",
  svg: `<circle cx="25" cy="25" r="25" fill="none" stroke="black" stroke-width="2"/>`
},
{
  name: "Pole (3)",
  svg: `
    <defs>
      <pattern id="hatchPattern" patternUnits="userSpaceOnUse" width="4" height="4">
        <path d="M-1,1 l2,-2
                 M0,4 l4,-4
                 M3,5 l2,-2" 
              stroke="black" stroke-width="0.5"/>
      </pattern>
    </defs>
    <circle cx="25" cy="25" r="25" fill="url(#hatchPattern)" stroke="black" stroke-width="2"/>
  `
},
{
  name: "9m Pole (1)",
  svg: `
    <circle cx="25" cy="25" r="25" fill="black" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle" font-size="24" font-family="Arial" fill="white">9m</text>
  `
},
{
  name: "9m Pole (2)",
  svg: `
    <circle cx="25" cy="25" r="25" fill="none" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle" font-size="24" font-family="Arial" fill="black">9m</text>
  `
},
{
  name: "9m Pole (3)",
  svg: `
    <defs>
      <pattern id="hatchPattern" patternUnits="userSpaceOnUse" width="4" height="4">
        <path d="M-1,1 l2,-2
                 M0,4 l4,-4
                 M3,5 l2,-2" 
              stroke="black" stroke-width="0.5"/>
      </pattern>
    </defs>
    <circle cx="25" cy="25" r="25" fill="url(#hatchPattern)" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle"
          font-size="24" font-family="Arial" fill="black">9m</text>
  `
},
{
  name: "8m Pole (1)",
  svg: `
    <circle cx="25" cy="25" r="25" fill="black" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle" font-size="24" font-family="Arial" fill="white">8m</text>
  `
},

{
  name: "8m Pole (2)",
  svg: `
    <circle cx="25" cy="25" r="25" fill="none" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle" font-size="24" font-family="Arial" fill="black">8m</text>
  `
},
{
  name: "8m Pole (3)",
  svg: `
    <defs>
      <pattern id="hatchPattern" patternUnits="userSpaceOnUse" width="4" height="4">
        <path d="M-1,1 l2,-2
                 M0,4 l4,-4
                 M3,5 l2,-2" 
              stroke="black" stroke-width="0.5"/>
      </pattern>
    </defs>
    <circle cx="25" cy="25" r="25" fill="url(#hatchPattern)" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle"
          font-size="24" font-family="Arial" fill="black">8m</text>
  `
},
{
  name: "H Pole (1)",
  svg: `
    <circle cx="25" cy="25" r="25" fill="none" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle" font-size="24" font-family="Arial" fill="black">H</text>
  `
},
{
  name: "H Pole (2)",
  svg: `
    <circle cx="25" cy="25" r="25" fill="black" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle" font-size="24" font-family="Arial" fill="white">H</text>
  `
},
{
  name: "H Pole (3)",
  svg: `
    <defs>
      <pattern id="hatchPattern" patternUnits="userSpaceOnUse" width="4" height="4">
        <path d="M-1,1 l2,-2
                 M0,4 l4,-4
                 M3,5 l2,-2" 
              stroke="black" stroke-width="0.5"/>
      </pattern>
    </defs>
    <circle cx="25" cy="25" r="25" fill="url(#hatchPattern)" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle"
          font-size="24" font-family="Arial" fill="black">H</text>
  `
},
{
  name: "Rail Pole (1)",
  svg: `
    <circle cx="25" cy="25" r="25" fill="none" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle" font-size="24" font-family="Arial" fill="black">R</text>
  `
},
{
  name: "Rail Pole (2)",
  svg: `
    <circle cx="25" cy="25" r="25" fill="black" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle" font-size="24" font-family="Arial" fill="white">R</text>
  `
},
{
  name: "Rail Pole (3)",
  svg: `
    <defs>
      <pattern id="hatchPattern" patternUnits="userSpaceOnUse" width="4" height="4">
        <path d="M-1,1 l2,-2
                 M0,4 l4,-4
                 M3,5 l2,-2" 
              stroke="black" stroke-width="0.5"/>
      </pattern>
    </defs>
    <circle cx="25" cy="25" r="25" fill="url(#hatchPattern)" stroke="black" stroke-width="2"/>
    <text x="25" y="25" text-anchor="middle" dominant-baseline="middle"
          font-size="24" font-family="Arial" fill="black">R</text>
  `
},

{
  name: "Double-Pole",
  svg: `
    <!-- Outer circle -->
    <circle cx="25" cy="25" r="24" fill="none" stroke="black" stroke-width="2"/>

    <!-- Two interconnected inner circles -->
    <circle cx="15" cy="25" r="8" fill="black" />
    <circle cx="35" cy="25" r="8" fill="black" />
  `
},


{
  name: "Triple-Pole",
  svg: `
    <!-- Outer circle -->
    <circle cx="25" cy="25" r="24" fill="none" stroke="black" stroke-width="2"/>
    
    <!-- Inner solid triangle -->
    <polygon points="25,12 35,35 15,35" fill="black" stroke="black" stroke-width="1.5"/>
  `
},

{
  name: "4-Pole",
  svg: `
    <!-- Outer circle -->
    <circle cx="25" cy="25" r="24" fill="none" stroke="black" stroke-width="2"/>
    
    <!-- Inner solid square -->
    <rect x="15" y="15" width="20" height="20" fill="black" stroke="black" stroke-width="1.5"/>
  `
}











]
