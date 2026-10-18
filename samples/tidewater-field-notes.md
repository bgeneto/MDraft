# The Quiet Machinery

*Field notes from the Tidewater Observatory*

The tide does not arrive all at once. It
advances in small, almost apologetic
movements: a line of foam, a darker band
of sand, the sudden cold around the
ankles. By the time the water reaches the
marker, the change has already happened.

## Reading the water

The gauge records the surface every six
minutes. For a simple sine, the height
above mean water is

$$
h(t) = A \sin\left(\frac{2\pi t}{T}\right)
$$

where `A` is the amplitude and `T` the
tidal period. Real estuaries are less
tidy: wind, river flow and the shape of
the channel all leave their signature.

| Station | Mean range | Spring range |
| :--- | ---: | ---: |
| North Bar | 2.4 m | 3.1 m |
| Bell Buoy | 1.8 m | 2.5 m |
| Inner Reach | 0.9 m | 1.3 m |

> The sea keeps time, but it does not keep it evenly.

## A small calculation

The gauge is a pressure sensor, so the
recorded number is not a height until it
has been corrected for the density of the
water above it:

```python
def surface_height(pressure, datum, rho=1025.0, g=9.81):
    """Convert gauge pressure to height above the survey datum."""
    return datum + pressure / (rho * g)
```

At Bell Buoy the datum sits 1.20 m below
mean water. A reading of 0.12 bar on a
calm morning puts the surface within a
centimetre of mean water — a small number
that matters to anyone rowing home.

## What the record leaves out

A tide table is a summary, not a
transcript. It cannot show the half hour
when the wind turned, or the fresh water
that arrived after three days of rain.
Those are the parts the notebook is for.
